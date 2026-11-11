// HTTP server for the compose container (runs in Cloudflare Containers; image in Dockerfile).
// POST /compose  multipart: manifest (JSON: { id, segments: [{ target, fit, cuts? }], audio: { start, duration }, width, height, fps }),
//   segment-0…segment-N (segment videos), audio (original track). Stitches, retimes and mixes, returns an MP4 with the track; results also stay in /tmp/compose/<id>/.
//   A segment with cuts is split at the scene cuts found in its video and each shot is retimed to its length; a missing cut fails the request.
// GET  /files/<id>/song.mp4 | /files/<id>/silent.mp4  read results.
// POST /faces  multipart: video (model output), original (unmasked clip of the shot), seconds, points (JSON [[x, y], ...]).
//   Returns { similarity: [...] }: per point, how closely any face in the output matches the original person there (faces.py). Read-only.
// Repeating compose with the same id overwrites the same files, so Workflow retries are idempotent.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildCutArgs,
  buildFfmpegArgs,
  buildSilentArgs,
  matchCuts,
  parseCutTimes,
  parsePoints,
  splitAtCuts,
} from './compose.mjs';

const run = promisify(execFile);
const ROOT = '/tmp/compose';
const KEEP = '/tmp/keep';
const ID = /^[a-z0-9_-]{1,80}$/;

async function durationOf(file) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  const value = Number(stdout.trim());
  if (!(value > 0)) throw new Error(`cannot read duration of ${file}`);
  return value;
}

async function save(form, field, file) {
  const value = form.get(field);
  if (!value || typeof value === 'string') throw new Error(`missing file ${field}`);
  await writeFile(file, Buffer.from(await value.arrayBuffer()));
}

async function compose(req) {
  const form = await new Request('http://local/', {
    method: 'POST',
    headers: req.headers,
    body: req,
    duplex: 'half',
  }).formData();
  const manifest = JSON.parse(String(form.get('manifest') ?? '{}'));
  if (!ID.test(manifest.id ?? '')) throw new Error('bad id');
  if (!Array.isArray(manifest.segments) || manifest.segments.length === 0) throw new Error('no segments');
  const dir = join(ROOT, manifest.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const segments = [];
  for (const [i, segment] of manifest.segments.entries()) {
     const file = join(dir, `in-${i}.mp4`);
    const kept = form.get(`segment-${i}-kept`);
    if (typeof kept === 'string' && ID.test(kept)) await copyFile(join(KEEP, manifest.id, `${kept}.mp4`), file);
    else await save(form, `segment-${i}`, file);
    const duration = await durationOf(file);
    if (!Array.isArray(segment.cuts) || segment.cuts.length === 0) {
      segments.push({ file, duration, target: segment.target, fit: segment.fit });
      continue;
    }
    const cuts = segment.cuts.map(Number);
    if (!cuts.every((cut, j) => cut > (j === 0 ? 0 : cuts[j - 1]) && cut < segment.target))
      throw new Error('bad cuts');
    // showinfo logs at info level; -nostats keeps progress lines out of stderr.
    const { stderr } = await run('ffmpeg', buildCutArgs(file), { maxBuffer: 16 * 1024 * 1024 });
    const detected = matchCuts(cuts, parseCutTimes(stderr));
    if (!detected) throw new Error(`segment ${i}: shot cuts not found in the output`);
    segments.push(...splitAtCuts({ file, duration, target: segment.target, cuts, detected }));
  }
  const audioFile = join(dir, 'audio-src');
  await save(form, 'audio', audioFile);
  const audio = { file: audioFile, start: manifest.audio.start, duration: manifest.audio.duration };
  const song = join(dir, 'song.mp4');
  await run(
    'ffmpeg',
    buildFfmpegArgs({
      segments,
      audio,
      width: manifest.width,
      height: manifest.height,
      fps: manifest.fps,
      output: song,
    }),
  );
  await run('ffmpeg', buildSilentArgs(song, join(dir, 'silent.mp4')));
  return song;
}

async function faces(req) {
  const form = await new Request('http://local/', {
    method: 'POST',
    headers: req.headers,
    body: req,
    duplex: 'half',
  }).formData();
  const seconds = Number(form.get('seconds'));
  if (!(Number.isFinite(seconds) && seconds > 0 && seconds <= 60)) throw new Error('bad seconds');
  const points = parsePoints(String(form.get('points') ?? ''));
  const dir = join('/tmp/faces', randomUUID());
  await mkdir(dir, { recursive: true });
  try {
    const video = join(dir, 'video.mp4');
    const original = join(dir, 'original.mp4');
       await save(form, 'video', video);
    await save(form, 'original', original);
    const keepId = String(form.get('id') ?? '');
    const keepAs = String(form.get('keep') ?? '');
    if (ID.test(keepId) && ID.test(keepAs)) {
      await mkdir(join(KEEP, keepId), { recursive: true });
      await copyFile(video, join(KEEP, keepId, `${keepAs}.mp4`));
    }
    const { stdout } = await run('python3', [
      'faces.py',
      video,
      original,
      String(seconds),
      JSON.stringify(points),
    ]);
    const check = JSON.parse(stdout);
    if (
      check.version !== 2 || !['pass', 'review', 'fail'].includes(check.verdict) ||
      !Array.isArray(check.similarity) || check.similarity.length !== points.length ||
      !check.similarity.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
      !Array.isArray(check.roles) || check.roles.length !== points.length
    ) throw new Error('bad faces v2 output');
    return check;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sendFile(res, file, size) {
  res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size });
  createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/compose') {
      const song = await compose(req);
      return sendFile(res, song, (await stat(song)).size);
    }
    if (req.method === 'POST' && req.url === '/faces') {
      const body = JSON.stringify(await faces(req));
      return res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    }
    const match = req.method === 'GET' && req.url?.match(/^\/files\/([a-z0-9_-]{1,80})\/(song|silent)\.mp4$/);
    if (match) {
      const file = join(ROOT, match[1], `${match[2]}.mp4`);
      const info = await stat(file).catch(() => null);
      if (!info) return res.writeHead(404).end('not found');
      return sendFile(res, file, info.size);
    }
       const kept = req.method === 'GET' && req.url?.match(/^\/kept\/([a-z0-9_-]{1,80})\/([a-z0-9_-]{1,80})$/);
    if (kept) {
      const info = await stat(join(KEEP, kept[1], `${kept[2]}.mp4`)).catch(() => null);
      return info ? res.writeHead(200).end('ok') : res.writeHead(404).end('not found');
    }
    if (req.url === '/health') return res.writeHead(200).end('ok');
    res.writeHead(404).end('not found');
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error?.message ?? error));
  }
}).listen(8080);
