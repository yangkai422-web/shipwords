// Effect video compose: stitch segments (model outputs or base clips) in order into one video, mix in the original track, plus a silent version.
// The actual ffmpeg runs in Cloudflare Containers (image in packages/jobs/compose/); this side only
// fetches files from R2, hands them to the container and stores the results.

import type { FacePoint } from './models';

export interface ComposeSegment {
  /** R2 key. */
  key: string;
  /** Seconds this occupies in the output. */
  target: number;
  /** stretch: retime the whole segment to target; trim: take the first target seconds at real speed. */
  fit: 'stretch' | 'trim';
  /** Shot cut times in the final cut: the container splits at the cuts it finds and retimes each shot (overrides fit). */
  cuts?: readonly number[];
}

export interface ComposeInput {
  jobId: string;
  segments: ComposeSegment[];
  audio: { key: string; start: number; duration: number };
  width: number;
  height: number;
  fps: number;
}

export interface FacesInput {
  jobId: string;
  /** Model output (R2 key). */
  key: string;
  /** Unmasked original clip of the shot (R2 key); original faces are read from its first frame. */
  originalKey: string;
  /** Face centers (fractions of width and height) in the original's first frame, or at t seconds for [x, y, t]; one per slot to check. */
  points: FacePoint[];
  /** Only look at the first few seconds of the output. */
  seconds: number;
}

export interface Composer {
  /** Repeated calls with the same jobId give the same result, safe for Workflow retries. */
  compose(input: ComposeInput): Promise<{ song: ArrayBuffer; silent: ArrayBuffer }>;
  /**
   * Output check: for each point, the highest face similarity (cosine, 0–1) between the original person there and any face in the output.
   * High means the original person is still in the output (not swapped). Same order as points. Read-only, repeatable.
   */
  faces(input: FacesInput): Promise<number[]>;
}

async function blobOf(bucket: R2Bucket, key: string): Promise<Blob> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`compose input missing: ${key}`);
  return new Blob([await object.arrayBuffer()], { type: 'application/octet-stream' });
}

/** Force-release the job's container VM; sleepAfter alone has left instances Running for days. */
async function destroyCompose(stub: DurableObjectStub): Promise<void> {
  try {
    await stub.fetch('http://compose/__destroy');
  } catch {
    // Best-effort: ComposeContainer.onActivityExpired also destroys.
  }
}

/**
 * The site binds the Container class as a Durable Object (e.g. COMPOSE) and picks an instance by jobId.
 * After each compose/faces call the VM is destroyed so idle standard-3 instances cannot keep billing.
 * Workflow step results are persisted, so a retry restarts a fresh container rather than reading old files.
 */
export function containerComposer(namespace: DurableObjectNamespace, bucket: R2Bucket): Composer {
  return {
    async compose(input) {
      const form = new FormData();
      form.set(
        'manifest',
        JSON.stringify({
          id: input.jobId,
          segments: input.segments.map(({ target, fit, cuts }) => ({
            target,
            fit,
            ...(cuts ? { cuts } : {}),
          })),
          audio: { start: input.audio.start, duration: input.audio.duration },
          width: input.width,
          height: input.height,
          fps: input.fps,
        }),
      );
      for (const [index, segment] of input.segments.entries()) {
        form.set(`segment-${index}`, await blobOf(bucket, segment.key), `${index}.mp4`);
      }
      form.set('audio', await blobOf(bucket, input.audio.key), 'audio');

      const stub = namespace.get(namespace.idFromName(input.jobId));
      try {
        const composed = await stub.fetch('http://compose/compose', { method: 'POST', body: form });
        if (!composed.ok) throw new Error(`compose failed: ${composed.status} ${await composed.text()}`);
        const song = await composed.arrayBuffer();
        const silent = await stub.fetch(`http://compose/files/${input.jobId}/silent.mp4`);
        if (!silent.ok) throw new Error(`compose silent copy failed: ${silent.status}`);
        return { song, silent: await silent.arrayBuffer() };
      } finally {
        await destroyCompose(stub);
      }
    },
    async faces(input) {
      const form = new FormData();
      form.set('seconds', String(input.seconds));
      form.set('points', JSON.stringify(input.points));
      form.set('video', await blobOf(bucket, input.key), 'video.mp4');
      form.set('original', await blobOf(bucket, input.originalKey), 'original.mp4');
      const stub = namespace.get(namespace.idFromName(input.jobId));
      try {
        const response = await stub.fetch('http://compose/faces', { method: 'POST', body: form });
        if (!response.ok) throw new Error(`faces failed: ${response.status} ${await response.text()}`);
        const { similarity } = (await response.json()) as { similarity?: unknown };
        if (
          !Array.isArray(similarity) ||
          similarity.length !== input.points.length ||
          !similarity.every((value) => typeof value === 'number')
        )
          throw new Error('faces returned no scores');
        return similarity as number[];
      } finally {
        await destroyCompose(stub);
      }
    },
  };
}
