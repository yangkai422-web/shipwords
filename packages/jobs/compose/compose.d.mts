// Type declarations for compose.mjs: the container runs the .mjs directly with Node, tests import it from TypeScript.
export interface Segment {
  file: string;
  duration: number;
  target: number;
  fit?: 'stretch' | 'trim';
  start?: number;
  ratio?: number;
}
export interface Audio {
  file: string;
  start: number;
  duration: number;
}
export function buildFfmpegArgs(spec: {
  segments: Segment[];
  audio?: Audio | null;
  width: number;
  height: number;
  fps: number;
  output: string;
  watermark?: string;
}): string[];
export function buildTrimArgs(input: {
  input: string;
  start: number;
  duration: number;
  output: string;
}): string[];
export function buildSilentArgs(input: string, output: string): string[];
export function parsePoints(text: string): ([number, number] | [number, number, number])[];
export function buildCutArgs(file: string): string[];
export function parseCutTimes(stderr: string): number[];
export function matchCuts(
  expected: readonly number[],
  detected: readonly number[],
  tolerance?: number,
): number[] | null;
export function splitAtCuts(input: {
  file: string;
  duration: number;
  target: number;
  cuts: readonly number[];
  detected: readonly number[];
}): Required<Pick<Segment, 'file' | 'start' | 'duration' | 'target' | 'ratio'>>[];
