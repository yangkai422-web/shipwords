// Effect video compose: retime each segment (model render or base clip) back to real speed, concatenate in order, then mix in the original track.
// Depends only on Node built-ins and the image's ffmpeg; server.mjs uses it for HTTP requests, tests call buildFfmpegArgs directly.

/**
 * @typedef {{ file: string; duration: number; target: number; fit?: 'stretch' | 'trim'; start?: number; ratio?: number }} Segment
 *   file: local file; duration: the file's actual length (s), or the piece length when start is set; target: length it should occupy in the output (s).
 *   fit: stretch (default) retimes the whole segment to target; trim takes the first target seconds at real speed.
 *   start: read only duration seconds from this point of the file (one shot of a longer clip, see splitAtCuts).
 *   ratio: fixed retime factor (setpts multiplier), overriding fit; the result is still cut or padded to target.
 * @typedef {{ file: string; start: number; duration: number }} Audio
 *   Original track: cut duration seconds starting at file's start second.
 */

/**
 * Build ffmpeg args. Segments are scaled to width×height and fps, retimed by target/duration, concatenated, and optionally mixed with an audio track.
 * @param {{ segments: Segment[]; audio?: Audio | null; width: number; height: number; fps: number; output: string; watermark?: string }} spec
 */
function escapeDrawtext(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '%%');
}

export function buildFfmpegArgs(spec) {
  const { segments, audio, width, height, fps, output, watermark } = spec;
  if (!segments.length) throw new Error('no segments');
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const segment of segments) {
    if (!(segment.duration > 0 && segment.target > 0)) throw new Error('segment durations must be positive');
    if (segment.ratio !== undefined && !(segment.ratio > 0))
      throw new Error('segment ratio must be positive');
    if (segment.start !== undefined) {
      if (!(segment.start >= 0)) throw new Error('segment start must not be negative');
      args.push('-ss', segment.start.toFixed(6), '-t', segment.duration.toFixed(6));
    }
    args.push('-i', segment.file);
  }
  if (audio) args.push('-ss', String(audio.start), '-t', String(audio.duration), '-i', audio.file);

  const frames = (seconds) => Math.round(seconds * fps);
  // Models render in whole seconds but often add 1 frame (6s comes out as 6.04s); using the actual length would skew the whole segment and break lip sync.
  // Within 1.5 frames we use the whole second; the extra frames are trimmed by the frame-count cut below.
  const nominal = (seconds) => {
    const whole = Math.round(seconds);
    return whole > 0 && Math.abs(seconds - whole) <= 1.5 / fps ? whole : seconds;
  };
  const filters = segments.map((segment, i) => {
    const ratio =
      segment.ratio !== undefined
        ? segment.ratio
        : segment.fit === 'trim'
          ? 1
          : segment.target / nominal(segment.duration);
    // Pad by the last frame at least one second, and enough to cover whatever the retimed segment is short of target,
    // so the frame-count cut below always yields exactly target (a fixed ratio can leave the last shot short by more than a second).
    const pad = fps + Math.max(0, frames(segment.target) - Math.floor(segment.duration * ratio * fps));
    // Retime first, then normalize frame rate, then cut by frame count so each segment is exact and the concat doesn't drift.
    return (
      `[${i}:v]setpts=${ratio.toFixed(6)}*(PTS-STARTPTS),scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},setsar=1,fps=${fps},tpad=stop_mode=clone:stop=${pad},trim=end_frame=${frames(segment.target)},setpts=PTS-STARTPTS[v${i}]`
    );
  });
  const inputs = segments.map((_, i) => `[v${i}]`).join('');
  const concatLabel = watermark ? '[vout]' : '[v]';
  filters.push(`${inputs}concat=n=${segments.length}:v=1:a=0${concatLabel}`);
  if (watermark) {
    const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    filters.push(
      `[vout]drawtext=fontfile=${font}:text='${escapeDrawtext(watermark)}':fontcolor=white@0.9:fontsize=h/16:x=(w-text_w)/2:y=h-text_h-h/14:box=1:boxcolor=black@0.45:boxborderw=12[v]`,
    );
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[v]');
  if (audio) args.push('-map', `${segments.length}:a`, '-c:a', 'aac', '-b:a', '160k', '-shortest');
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  );
  return args;
}

/** Scene cut detection: ffmpeg prints one showinfo line per frame whose scene score passes the threshold. Read pts_time from stderr. */
export function buildCutArgs(file) {
  return [
    '-hide_banner',
    '-nostats',
    '-i',
    file,
    '-an',
    '-vf',
    "select='gt(scene,0.3)',showinfo",
    '-f',
    'null',
    '-',
  ];
}

/** Cut times (s) from buildCutArgs stderr, in order. */
export function parseCutTimes(stderr) {
  return [...String(stderr).matchAll(/Parsed_showinfo[^\n]*\spts_time:\s*([0-9.]+)/g)].map((match) =>
    Number(match[1]),
  );
}

/**
 * Match each expected cut to the nearest detected cut within tolerance seconds, keeping them in order.
 * Extra detected cuts (flashes, fast motion) are ignored. Returns null if any expected cut has no match.
 */
export function matchCuts(expected, detected, tolerance = 0.5) {
  const matched = [];
  let after = 0;
  for (const cut of expected) {
    let best = null;
    for (const time of detected) {
      if (time <= after || Math.abs(time - cut) > tolerance) continue;
      if (best === null || Math.abs(time - cut) < Math.abs(best - cut)) best = time;
    }
    if (best === null) return null;
    matched.push(best);
    after = best;
  }
  return matched;
}

/** Seconds the last shot may fall short of its target (padded with its last frame) before the output counts as broken. */
const LAST_SHOT_SLACK = 0.5;

/**
 * Split one rendered clip into its shots at the matched cuts and retime each shot to its length in the final cut.
 * cuts: expected cut times in the final cut; detected: the matched cut times in the clip (same length, from matchCuts).
 * The last shot has no closing cut, so it uses the drift of the last cut and is cut or padded to the remaining target;
 * more than LAST_SHOT_SLACK short throws (the model dropped the end of the clip).
 */
export function splitAtCuts({ file, duration, target, cuts, detected }) {
  if (cuts.length !== detected.length || cuts.length === 0)
    throw new Error('cuts and detected cuts must match');
  const ends = [...cuts, target];
  const starts = [0, ...detected];
  return ends.map((end, i) => {
    const from = starts[i];
    const shot = end - (i === 0 ? 0 : cuts[i - 1]);
    if (i < cuts.length) {
      const length = detected[i] - from;
      return { file, start: from, duration: length, target: shot, ratio: shot / length };
    }
    const ratio = cuts[cuts.length - 1] / detected[detected.length - 1];
    const length = duration - from;
    // A last shot much shorter than the original would be padded with a frozen frame; treat it as a broken output instead.
    if (!(length * ratio >= shot - LAST_SHOT_SLACK))
      throw new Error(`last shot is ${(length * ratio).toFixed(2)}s, expected ${shot.toFixed(2)}s`);
    return { file, start: from, duration: length, target: shot, ratio };
  });
}

/**
 * Output check points: a JSON list of 1–10 points, each [x, y] or [x, y, t]: a face center as fractions of the frame (0–1),
 * and optionally the time (0–60 s) in the original clip to read that face from. Throws on anything else.
 */
export function parsePoints(text) {
  const points = JSON.parse(text);
  if (
    !Array.isArray(points) ||
    points.length === 0 ||
    points.length > 10 ||
    !points.every(
      (point) =>
        Array.isArray(point) &&
        (point.length === 2 || point.length === 3) &&
        point.every((value) => typeof value === 'number' && Number.isFinite(value)) &&
        point[0] >= 0 &&
        point[0] <= 1 &&
        point[1] >= 0 &&
        point[1] <= 1 &&
        (point.length === 2 || (point[2] >= 0 && point[2] <= 60)),
    )
  )
    throw new Error('bad points');
  return points;
}

/** Silent version: drop the audio track, copy the video stream as-is. */
export function buildSilentArgs(input, output) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-an',
    '-c:v',
    'copy',
    '-movflags',
    '+faststart',
    output,
  ];
}

/** Cut start..start+duration from a reference clip and re-encode so the preview upstream gets a short, cheap input. */
export function buildTrimArgs({ input, start, duration, output }) {
  if (!(start >= 0) || !(duration > 0)) throw new Error('trim window must be positive');
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(start),
    '-t',
    String(duration),
    '-i',
    input,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    output,
  ];
}
