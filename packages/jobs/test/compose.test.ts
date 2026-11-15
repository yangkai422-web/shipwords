import { describe, expect, it } from 'vitest';
import {
  buildFfmpegArgs,
  buildSilentArgs,
  buildTrimArgs,
  matchCuts,
  parseCutTimes,
  parsePoints,
  splitAtCuts,
} from '../compose/compose.mjs';

// ffmpeg itself runs in the container; here we only check args: retime ratio, frame-count cut, concat order, optional audio.
describe('compose args', () => {
  const spec = {
    segments: [
      { file: 'a.mp4', duration: 5, target: 5.333 },
      { file: 'b.mp4', duration: 4, target: 2.688 },
    ],
    width: 720,
    height: 1280,
    fps: 24,
    output: 'out.mp4',
  };

  it('retimes each segment by target/duration, cuts to target frame count, concatenates in order and mixes the original track', () => {
    const args = buildFfmpegArgs({ ...spec, audio: { file: 'song.mp4', start: 1.375, duration: 8.021 } });
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[0:v]setpts=1.066600*(PTS-STARTPTS)');
    expect(graph).toContain('trim=end_frame=128');
    expect(graph).toContain('[1:v]setpts=0.672000*(PTS-STARTPTS)');
    expect(graph).toContain('trim=end_frame=65');
    expect(graph).toContain('[v0][v1]concat=n=2:v=1:a=0[v]');
    expect(args).toEqual(
      expect.arrayContaining(['-ss', '1.375', '-t', '8.021', '-i', 'song.mp4', '-map', '2:a']),
    );
    expect(args.at(-1)).toBe('out.mp4');
  });

  it('an extra model frame does not affect the retime ratio: 6.04s counts as 6s, actual length used only beyond 1.5 frames', () => {
    const graph = (duration: number) => {
      const args = buildFfmpegArgs({ ...spec, segments: [{ file: 'a.mp4', duration, target: 6.292 }] });
      return args[args.indexOf('-filter_complex') + 1]!;
    };
    expect(graph(6.041667)).toContain('setpts=1.048667*(PTS-STARTPTS)');
    expect(graph(5.958333)).toContain('setpts=1.048667*(PTS-STARTPTS)');
    expect(graph(6.2)).toContain('setpts=1.014839*(PTS-STARTPTS)');
    expect(graph(6.041667)).toContain('trim=end_frame=151');
  });

  it('no audio mapping without a track; empty segments and non-positive durations throw', () => {
    expect(buildFfmpegArgs(spec)).not.toContain('-c:a');
    expect(() => buildFfmpegArgs({ ...spec, segments: [] })).toThrow(/no segments/);
    expect(() => buildFfmpegArgs({ ...spec, segments: [{ file: 'a', duration: 0, target: 1 }] })).toThrow(
      /positive/,
    );
  });

  it('silent version drops audio and copies the video stream as-is', () => {
    expect(buildSilentArgs('in.mp4', 'out.mp4')).toEqual(expect.arrayContaining(['-an', '-c:v', 'copy']));
  });
});

// Numbers from a real Kling 4.0 edit: 17.688 s cut list, output 18.042 s with every cut 1–3 frames late.
describe('shot cut alignment', () => {
  const cuts = [5.333, 11.625, 15.0];
  const detected = [5.375, 11.708333, 15.125];

  it('reads showinfo pts_time lines only', () => {
    const stderr = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mp4':",
      '[Parsed_showinfo_1 @ 0x1] n:   0 pts:  10320 pts_time:5.375   duration:    512',
      '[Parsed_showinfo_1 @ 0x1] n:   1 pts:  22480 pts_time:11.708333 duration:    512',
      'frame=  433 fps=0.0 q=-0.0 Lsize=N/A time=00:00:18.04',
    ].join('\n');
    expect(parseCutTimes(stderr)).toEqual([5.375, 11.708333]);
  });

  it('matches each expected cut to the nearest detected one within 0.5 s, ignores extra cuts, null when one is missing', () => {
    expect(matchCuts(cuts, [2.1, ...detected, 17.2])).toEqual(detected);
    expect(matchCuts(cuts, [5.375, 11.708333])).toBeNull();
    expect(matchCuts(cuts, [5.375, 12.3, 15.125])).toBeNull();
    // Two expected cuts never share one detected cut.
    expect(matchCuts([1, 1.2], [1.1])).toBeNull();
  });

  it('splits into shots retimed to their exact lengths; the last shot uses the last cut drift and is cut to the remaining target', () => {
    const pieces = splitAtCuts({ file: 'k.mp4', duration: 18.041995, target: 17.688, cuts, detected });
    expect(pieces.map((p) => p.start)).toEqual([0, 5.375, 11.708333, 15.125]);
    expect(pieces.map((p) => p.target)).toEqual([5.333, 11.625 - 5.333, 15 - 11.625, 17.688 - 15]);
    for (const piece of pieces.slice(0, 3)) expect(piece.duration * piece.ratio).toBeCloseTo(piece.target, 9);
    expect(pieces[3]!.ratio).toBeCloseTo(15 / 15.125, 9);
    const args = buildFfmpegArgs({ segments: pieces, width: 720, height: 1280, fps: 24, output: 'o.mp4' });
    expect(args.slice(0, 12)).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      '0.000000',
      '-t',
      '5.375000',
      '-i',
      'k.mp4',
      '-ss',
      '5.375000',
    ]);
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[0:v]setpts=0.992186*(PTS-STARTPTS)');
    expect(graph).toContain('[3:v]setpts=0.991736*(PTS-STARTPTS)');
    // 5.333 + 6.292 + 3.375 + 2.688 s at 24 fps: 128 + 151 + 81 + 65 frames.
    for (const frames of [128, 151, 81, 65]) expect(graph).toContain(`trim=end_frame=${frames},`);
  });
});

describe('last shot length', () => {
  const cuts = [5.333, 11.625, 15.0];
  const detected = [5.375, 11.708333, 15.125];
  const split = (duration: number) =>
    splitAtCuts({ file: 'k.mp4', duration, target: 17.688, cuts, detected });

  it('pads by whatever the retimed segment is short of target, at least one second, so the frame cut is always exact', () => {
    // Last shot 2.4 s of output at 0.9917: 2.38 s for a 2.688 s target, 8 frames short.
    const pieces = split(15.125 + 2.4);
    const graph = buildFfmpegArgs({
      segments: pieces,
      width: 720,
      height: 1280,
      fps: 24,
      output: 'o.mp4',
    }).find((arg) => arg.includes('concat='))!;
    const last = graph.split(';')[3]!;
    expect(last).toContain('trim=end_frame=65,');
    const pad = Number(last.match(/tpad=stop_mode=clone:stop=(\d+)/)![1]);
    expect(pad).toBeGreaterThanOrEqual(24 + 8);
    // A plain retimed segment far shorter than its target gets the full gap, not one second.
    const short = buildFfmpegArgs({
      segments: [{ file: 'a.mp4', duration: 1, target: 4, ratio: 1 }],
      width: 720,
      height: 1280,
      fps: 24,
      output: 'o.mp4',
    }).find((arg) => arg.includes('concat='))!;
    expect(short).toContain('tpad=stop_mode=clone:stop=96,trim=end_frame=96,');
  });

  it('a last shot more than half a second short means the model dropped the end: throws', () => {
    expect(() => split(15.125 + 2.4)).not.toThrow();
    expect(() => split(15.125 + 1.0)).toThrow(/last shot/);
  });
});

describe('output check points', () => {
  it('accepts 1–10 [x, y] or [x, y, t] points (x, y in 0–1, t in 0–60 s), rejects anything else', () => {
    expect(parsePoints('[[0.48,0.5],[0.1,0.21,11.67]]')).toEqual([
      [0.48, 0.5],
      [0.1, 0.21, 11.67],
    ]);
    for (const bad of [
      '[]',
      '[[0.5]]',
      '[[0.5,1.2]]',
      '[[0.5,0.5,-1]]',
      '[[0.5,0.5,61]]',
      '[[0.5,0.5,1,2]]',
      '[["0.5",0.5]]',
      '{"x":1}',
      JSON.stringify(Array(11).fill([0.5, 0.5])),
    ]) {
      expect(() => parsePoints(bad)).toThrow();
    }
    expect(() => parsePoints('not json')).toThrow();
  });
});

describe('watermark args', () => {
  it('overlays a drawtext watermark after concat when watermark is set', () => {
    const args = buildFfmpegArgs({
      segments: [
        { file: 'a.mp4', duration: 5, target: 5.333 },
        { file: 'b.mp4', duration: 4, target: 2.688 },
      ],
      width: 720,
      height: 1280,
      fps: 24,
      output: 'out.mp4',
      watermark: 'FACERIFF',
    });
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('concat=n=2:v=1:a=0[vout]');
    expect(graph).toContain("drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='FACERIFF'");
    expect(graph.endsWith('[v]')).toBe(true);
  });
});

describe('trim args', () => {
  it('cuts a short window and re-encodes it', () => {
    expect(buildTrimArgs({ input: 'full.mp4', start: 5.333, duration: 5, output: 'clip.mp4' })).toEqual(
      expect.arrayContaining(['-ss', '5.333', '-t', '5', '-i', 'full.mp4', 'clip.mp4']),
    );
  });

  it('rejects a non-positive window', () => {
    expect(() => buildTrimArgs({ input: 'a', start: -1, duration: 5, output: 'o' })).toThrow(/trim window/);
    expect(() => buildTrimArgs({ input: 'a', start: 0, duration: 0, output: 'o' })).toThrow(/trim window/);
  });
});
