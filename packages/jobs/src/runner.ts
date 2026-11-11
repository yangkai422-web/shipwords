import type { Db } from '@shipwords/core/db/client';
import type { Composer, ComposeSegment } from './compose';
import {
  appendUpstreamJob,
  loadJob,
  markFailed,
  markQualityReview,
  markSucceeded,
  recordUpstreamCost,
  SKIPPED_UPSTREAM as SKIPPED,
  type StoredOutput,
  settleFailure,
  upstreamIds,
} from './lifecycle';
import { type FacePoint, type JobPart, type ModelDefinition, PREP_REF } from './models';
import { type JobRow, TERMINAL } from './schema';
import type { OutputFile, PollResult, SubmitInput, UpstreamAdapter } from './upstream';
import { UpstreamError } from './upstream';

// The full execution of one generation job. The Workflow persists each step's result and resumes after interruption;
// this only depends on the StepRunner interface, so tests pass an implementation that runs directly.

export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export interface RunnerDeps {
  db: Db;
  bucket: R2Bucket;
  models: readonly ModelDefinition[];
  adapters: Record<string, UpstreamAdapter>;
  /** Effect compose (effect.compose); empty when the site binds no container, and jobs that need compose fail with a refund. */
  composer?: Composer;
  fetcher?: typeof fetch;
  /** Notify the user when the job succeeds or fails (e.g. email) so they don't have to wait on the page; errors are only logged and don't affect the job. */
  notify?: (job: JobRow) => Promise<void>;
  log?: (message: string, details: Record<string, unknown>) => void;
}

const POLL_WAIT_SECONDS = 20;
const POLL_PAUSE_MS = 3_000;
/** Prep images usually finish in about 35 s; one still running past this gets a second copy, and whichever finishes first is used. */
export const PREP_HEDGE_MS = 60_000;

function extensionFor(mediaType: string): string {
  const subtype = mediaType.split('/')[1]?.split(';')[0] ?? 'bin';
  return subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
}

/** Upstream result links expire, so copy the files into our own R2 before finishing. */
export async function storeOutputs(
  deps: RunnerDeps,
  jobId: string,
  files: OutputFile[],
  /** Starting index of this segment's outputs in a multi-part job, so keys don't collide. */
  startIndex = 0,
): Promise<StoredOutput[]> {
  const fetcher = deps.fetcher ?? fetch;
  const stored: StoredOutput[] = [];
  for (const [index, file] of files.entries()) {
    const response = await fetcher(file.url);
    if (!response.ok || !response.body)
      throw new Error(`download output ${index} failed: ${response.status}`);
    const mediaType = response.headers.get('content-type') ?? file.mediaType;
    const key = `jobs/${jobId}/${startIndex + index}.${extensionFor(mediaType)}`;
    await deps.bucket.put(key, response.body, { httpMetadata: { contentType: mediaType } });
    stored.push({ key, mediaType });
  }
  return stored;
}

/**
 * Each Workflow step retries on its own; once retries are exhausted step.do throws. This fallback marks the job failed and refunds,
 * otherwise the job would stay in progress forever and the user's credits would never come back.
 */
export async function runGeneration(deps: RunnerDeps, jobId: string, step: StepRunner): Promise<void> {
  try {
    await runSteps(deps, jobId, step);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.('generation aborted', { jobId, error: message });
    await step.do('abort', async () => {
      // In a multi-part job some segments may still be running upstream: after fail + refund nobody needs them, so cancel to avoid wasted charges.
      const job = await loadJob(deps.db, jobId);
      const adapter = job ? deps.adapters[job.upstream] : undefined;
      if (job && adapter && !TERMINAL.includes(job.status)) await cancelAll(adapter, upstreamIds(job));
      await markFailed(deps.db, jobId, 'failed', 'internal_error', message);
      return true;
    });
  }
    const release = deps.composer?.release;
  if (release) {
    await step
      .do('release-container', async () => {
        await release(jobId);
        return true;
      })
      .catch((error: unknown) => deps.log?.('container release failed', { jobId, error: String(error) }));
  }
  // Always settle once at the end: if a step marked the job failed but the refund write failed, on retry that step is skipped because the job is terminal,
  // so settle here on the final state (refunds and quota returns are idempotent).
  await step.do('settle', async () => {
    const job = await loadJob(deps.db, jobId);
    if (job) await settleFailure(deps.db, job);
    return true;
  });
  const notify = deps.notify;
  if (notify) {
    // After settle, so a failure email can say the credits are back. Best-effort: if it still fails after retries, only log it.
    await step
      .do('notify', async () => {
        const job = await loadJob(deps.db, jobId);
        // Canceled jobs aren't notified: the user did it themselves.
        if (job?.status === 'succeeded' || job?.status === 'failed') await notify(job);
        return true;
      })
      .catch((error: unknown) => deps.log?.('notify failed', { jobId, error: String(error) }));
  }
  // Last, since it may wait for billing to settle. Best-effort like notify.
  await recordCost(deps, jobId, step).catch((error: unknown) =>
    deps.log?.('cost record failed', { jobId, error: String(error) }),
  );
}

/** Billing can settle after the result lands: re-read this many times, this far apart. */
const COST_READS = 4;
const COST_PAUSE_MS = 30_000;

/**
 * Record what the upstream actually charged, summed over every upstream task of the job; failed jobs can cost money too.
 * Every complete read is written, so a later read that fails keeps the amount already seen; still unsettled after the last read is logged.
 * Not counted: prep hedge copies (not in upstream_job_id) and jobs canceled by the user (the cancel terminates the Workflow first).
 */
async function recordCost(deps: RunnerDeps, jobId: string, step: StepRunner): Promise<void> {
  for (let attempt = 0; attempt < COST_READS; attempt++) {
    const done = await step.do(`cost:${attempt}`, async () => {
      const job = await loadJob(deps.db, jobId);
      const adapter = job ? deps.adapters[job.upstream] : undefined;
      if (!job || !TERMINAL.includes(job.status) || !adapter?.cost) return true;
      const ids = upstreamIds(job).filter((id) => !id.startsWith(SKIPPED));
      if (ids.length === 0) return true;
      const costs = await Promise.all(ids.map((id) => adapter.cost!(id)));
      await recordUpstreamCost(deps.db, jobId, sumUsd(costs.map((cost) => cost.usd)));
      const settled = costs.every((cost) => cost.settled);
      if (!settled && attempt === COST_READS - 1) deps.log?.('upstream cost not settled', { jobId, costs });
      return settled;
    });
    if (done || attempt === COST_READS - 1) return;
    await step.sleep(`cost-wait:${attempt}`, COST_PAUSE_MS);
  }
}

/** Add USD strings in micro-dollars to avoid float drift; "3.06" + "0.0085" → "3.0685". */
export function sumUsd(amounts: readonly string[]): string {
  const micros = amounts.reduce((sum, amount) => {
    const value = Number(amount);
    if (!Number.isFinite(value)) throw new Error(`bad upstream cost: ${amount}`);
    return sum + Math.round(value * 1e6);
  }, 0);
  return (micros / 1e6).toFixed(6).replace(/\.?0+$/, '');
}

interface SegmentCheck {
  maxSimilarity: number;
  /** Missing on checks cached by older versions (per-second SSIM): those jobs are delivered unchecked. */
  original?: string;
  faces?: Readonly<Record<string, FacePoint>>;
  seconds: number;
}

interface JobInput {
  references?: { url: string; role: string }[];
  parameters?: Record<string, unknown>;
  parts?: JobPart[];
}

export function partsOf(job: { prompt: string; inputJson: string }, model: ModelDefinition): JobPart[] {
  const input = JSON.parse(job.inputJson) as JobInput;
  if (input.parts?.length) return input.parts;
  return [
    {
      id: 'main',
      upstreamModel: model.upstreamModel,
      prompt: job.prompt,
      references: input.references ?? [],
      parameters: input.parameters ?? {},
      ...(model.maxCost ? { maxCost: model.maxCost } : {}),
    },
  ];
}

/**
 * Poll copies of the same request: the first success wins and the other copies are canceled.
 * Running while any copy runs; a query error is thrown only when no copy succeeded or is still running; failed once every copy failed.
 */
async function pollCopies(
  adapter: UpstreamAdapter,
  ids: readonly string[],
  waitSeconds: number,
): Promise<PollResult> {
  type Outcome = { id: string; result: PollResult } | { id: string; error: unknown };
  const outcomes = await new Promise<Outcome[]>((resolve) => {
    const done: Outcome[] = [];
    const settle = (outcome: Outcome) => {
      done.push(outcome);
      if (('result' in outcome && outcome.result.state === 'succeeded') || done.length === ids.length)
        resolve(done);
    };
    for (const id of ids)
      adapter.poll(id, waitSeconds).then(
        (result) => settle({ id, result }),
        (error: unknown) => settle({ id, error }),
      );
  });
  const results = outcomes.flatMap((outcome) => ('result' in outcome ? [outcome] : []));
  const won = results.find(({ result }) => result.state === 'succeeded');
  if (won) {
    await cancelAll(
      adapter,
      ids.filter((id) => id !== won.id),
    );
    return won.result;
  }
  const running = results.find(({ result }) => result.state === 'running');
  if (running) return running.result;
  const errored = outcomes.find((outcome) => 'error' in outcome);
  if (errored && 'error' in errored) throw errored.error;
  return results[0]!.result;
}

async function cancelAll(adapter: UpstreamAdapter, ids: readonly string[]) {
  await Promise.all(
    ids.filter((id) => !id.startsWith(SKIPPED)).map((id) => adapter.cancel(id).catch(() => undefined)),
  );
}

async function runSteps(deps: RunnerDeps, jobId: string, step: StepRunner): Promise<void> {
  const setup = await step.do('load', async () => {
    const job = await loadJob(deps.db, jobId);
    if (!job || TERMINAL.includes(job.status)) return null;
    const model = deps.models.find((m) => m.id === job.modelId);
    if (!model) return { missingModel: job.modelId };
    const parts = partsOf(job, model).map((part) => part.id);
    return {
      modelId: job.modelId,
      upstream: model.upstream,
      timeoutMinutes: model.timeoutMinutes,
      createdAt: job.createdAt,
      parts,
      prep: partsOf(job, model).filter((part) => part.kind === 'image' && model.kind === 'video').length,
      compose: Boolean(model.effect?.compose),
      // Output checks: segment ID → config. Cached loads from older versions lack this, so old in-flight jobs keep running unchecked.
      checks: Object.fromEntries(
        (model.effect?.segments ?? [])
          .filter((segment) => segment.check && parts.includes(segment.id))
          .map((segment) => [
            segment.id,
            {
              maxSimilarity: segment.check!.maxSimilarity,
              original: segment.check!.original,
              faces: segment.check!.faces,
              // trim segments only put the first target seconds into the output, not rounded: comparing more would include the next shot that gets cut, less would miss the last frames.
              // stretch segments use the whole clip, so compare over the model duration.
              seconds:
                segment.fit === 'trim'
                  ? segment.target!
                  : Number(segment.parameters.duration) || segment.target!,
            },
          ]),
      ) as Record<string, SegmentCheck>,
    };
  });
  if (!setup) return;
  if ('missingModel' in setup) {
    await step.do('fail:model_removed', async () => {
      await markFailed(
        deps.db,
        jobId,
        'failed',
        'model_removed',
        `model ${setup.missingModel} is no longer configured`,
      );
      return true;
    });
    return;
  }
  const adapter = deps.adapters[setup.upstream];
  if (!adapter) {
    await step.do('fail:upstream_missing', async () => {
      await markFailed(deps.db, jobId, 'failed', 'upstream_missing', `no adapter for ${setup.upstream}`);
      return true;
    });
    return;
  }

  // Single-part jobs keep their original step names and idempotency keys so old in-flight jobs line up on replay; older cached loads lack parts.
  const partIds = setup.parts ?? ['main'];
  const single = partIds.length === 1;
  const name = (base: string, part: string) => (single ? base : `${base}:${part}`);
  /** On failure cancel every submitted segment: the others are still running upstream and keep billing. */
  const fail = (code: string, message: string) =>
    step.do(`fail:${code}`, async () => {
      const job = await loadJob(deps.db, jobId);
      if (job) await cancelAll(adapter, upstreamIds(job));
      await markFailed(deps.db, jobId, 'failed', code, message);
      return true;
    });

  // Timeout counts from job creation and is only checked inside a step: on Workflow replay, code outside steps runs again.
  const deadline = setup.createdAt + setup.timeoutMinutes * 60_000;
  const prepCount = setup.prep ?? 0;
  /** Prep results: prep segment ID → image URL returned by the upstream; video segments' prep:<slot> placeholders are replaced with it at submit. */
  const prepUrls = new Map<string, string>();
  const submittedIds: string[] = [];
  const outputs: StoredOutput[] = [];
  /** Key of each segment's first output, looked up by segment ID when composing. */
  const partKeys = new Map<string, string>();
  const timeOut = () =>
    step.do('timeout', async () => {
      const job = await loadJob(deps.db, jobId);
      if (job) await cancelAll(adapter, upstreamIds(job));
      await markFailed(
        deps.db,
        jobId,
        'failed',
        'timeout',
        `no result after ${setup.timeoutMinutes} minutes`,
      );
      return true;
    });

  /** Upstream request for segment `index`: prep placeholders replaced with prep results. */
  const submitInput = (job: JobRow, index: number): SubmitInput => {
    const model = deps.models.find((m) => m.id === job.modelId)!;
    const part = partsOf(job, model)[index]!;
    const references = part.references.map((ref) => {
      if (!ref.url.startsWith(PREP_REF)) return ref;
      const url = prepUrls.get(`prep-${ref.url.slice(PREP_REF.length)}`);
      if (!url) throw new Error(`part ${part.id} needs ${ref.url} before it is ready`);
      return { ...ref, url };
    });
    return {
      upstreamModel: part.upstreamModel,
      kind: part.kind ?? model.kind,
      prompt: part.prompt,
      references,
      parameters: part.parameters,
      ...(part.maxCost ? { maxCost: part.maxCost } : {}),
    };
  };
  /** Poll until done; an empty label uses the single-part step name. */
  const pollUntilDone = async (upstreamJobId: string, label: string | null) => {
    for (let attempt = 0; ; attempt++) {
      const result: PollResult | { state: 'stopped' } | { state: 'timeout' } = await step.do(
        label === null ? `poll:${attempt}` : `poll:${label}:${attempt}`,
        async () => {
          // After a user cancel the local state is terminal; stop polling.
          const job = await loadJob(deps.db, jobId);
          if (!job || TERMINAL.includes(job.status)) return { state: 'stopped' as const };
          if (Date.now() > deadline) return { state: 'timeout' as const };
          const polled = await adapter.poll(upstreamJobId, POLL_WAIT_SECONDS);
          if (polled.state !== 'running')
            deps.log?.('timing', { jobId, stage: 'yir_wait', state: polled.state, msSinceCreated: Date.now() - job.createdAt });
          return polled;
        },
      );
      if (result.state !== 'running') return result;
      await step.sleep(label === null ? `pause:${attempt}` : `pause:${label}:${attempt}`, POLL_PAUSE_MS);
    }
  };
  /**
   * Poll every prep segment together until each finishes. A prep still running PREP_HEDGE_MS after job creation gets one copy,
   * since one stuck image holds back every video segment; the first copy to succeed is used and the other canceled (pollCopies).
   * Copies are not recorded in upstream_job_id (video segments haven't taken their positions yet): this loop cancels them when it sees
   * the job stopped or timed out. A user cancel terminates the Workflow, so a copy still running then is left to finish upstream (at most one prep maxCost).
   * Step names replaced the per-prep `poll:<prep>:<n>` of earlier versions: deploy with no effect job in flight, or a replayed job past prep re-polls its preps live.
   */
  type Finished = Exclude<PollResult, { state: 'running' }>;
  const pollPreps = async (
    pending: readonly { partId: string; index: number; upstreamJobId: string }[],
  ): Promise<
    { state: 'stopped' } | { state: 'timeout' } | { state: 'done'; results: Map<string, Finished> }
  > => {
    const results = new Map<string, Finished>();
    const copies = new Map<string, string>();
    const hedged = new Set<string>();
    for (let attempt = 0; ; attempt++) {
      const open = pending.filter((part) => !results.has(part.partId));
      const polled = await step.do(`poll:prep:${attempt}`, async () => {
        const job = await loadJob(deps.db, jobId);
        const stopped = !job || TERMINAL.includes(job.status);
        if (stopped || Date.now() > deadline) {
          await cancelAll(adapter, [...copies.values()]);
          return { state: stopped ? ('stopped' as const) : ('timeout' as const) };
        }
        const states = await Promise.all(
          open.map((part) => {
            const copy = copies.get(part.partId);
            return pollCopies(
              adapter,
              copy ? [part.upstreamJobId, copy] : [part.upstreamJobId],
              POLL_WAIT_SECONDS,
            );
          }),
        );
        const late = Date.now() - setup.createdAt > PREP_HEDGE_MS;
        return {
          state: 'polled' as const,
          results: Object.fromEntries(open.map((part, i) => [part.partId, states[i]!])),
          // Decided inside the step: replaying a cached poll must never hedge a prep that has since finished.
          hedge: open
            .filter((part, i) => late && states[i]!.state === 'running' && !hedged.has(part.partId))
            .map((part) => part.partId),
        };
      });
      if (polled.state !== 'polled') return polled;
      for (const [partId, result] of Object.entries(polled.results))
        if (result.state !== 'running') results.set(partId, result as Finished);
      for (const partId of polled.hedge) {
        hedged.add(partId);
        const part = pending.find((candidate) => candidate.partId === partId)!;
        // Best effort and no Workflow retries: if the copy can't be placed, keep waiting on the original.
        const copy = await step.do(`hedge:${partId}`, async () => {
          const job = await loadJob(deps.db, jobId);
          // A replay can resume here past the deadline: a copy then could never be used.
          if (!job || TERMINAL.includes(job.status) || Date.now() > deadline) return null;
          try {
            const { upstreamJobId } = await adapter.submit(
              submitInput(job, part.index),
              `${jobId}:${partId}:hedge`,
            );
            return upstreamJobId;
          } catch (error) {
            deps.log?.('prep hedge failed', { jobId, part: partId, error: String(error) });
            return null;
          }
        });
        if (copy) copies.set(partId, copy);
      }
      if (results.size === pending.length) return { state: 'done' as const, results };
      if (polled.hedge.length === 0) await step.sleep(`pause:prep:${attempt}`, POLL_PAUSE_MS);
    }
  };
  /**
   * Output check: if an original person this segment should replace is still in the output (swap didn't take), fail the whole job with a refund.
   * No rerun: a video render costs dollars, so a missed swap is refunded rather than paid for twice.
   * Only slots the user filled are checked: the others keep the original on purpose.
   * Errors in the check itself (container failure, unreadable output) fail the job with a refund: an unchecked video may be the original clip,
   * and refunding one good video costs less than charging for a broken one. Returns false if the job has ended.
   */
  const verify = async (partId: string, index: number, check: SegmentCheck): Promise<boolean> => {
    const { original, faces } = check;
    const key = partKeys.get(partId);
    if (!key) return true;
    const rolePolicy = setup.modelId === 'tiny-desk';
    const review = (message: string) => step.do(`review:${partId}:v2`, async () => {
      await markQualityReview(deps.db, jobId, message);
      return true;
    });
    const verdict = await step
      .do(`check:${partId}:0`, async () => {
        const job = await loadJob(deps.db, jobId);
        if (!job || TERMINAL.includes(job.status)) return { stopped: true as const };
        if (!original || !faces) return { scores: [] as number[] };
        const model = deps.models.find((m) => m.id === job.modelId)!;
        const points = (partsOf(job, model)[index]!.slots ?? [])
          .map((slot) => faces[slot])
          .filter((point): point is FacePoint => Boolean(point));
        if (!deps.composer || points.length === 0) return { scores: [] as number[] };
        const t = Date.now();
        const checked = await deps.composer.faces({
          jobId, key, originalKey: original, points, seconds: check.seconds,
        });
        deps.log?.('timing', { jobId, stage: 'face_check', part: partId, ms: Date.now() - t });
        return Array.isArray(checked) ? { scores: checked } : { scores: checked.similarity, quality: checked };
      })
      .catch((error: unknown) => {
        deps.log?.('swap check errored', { jobId, part: partId, error: String(error) });
        return { errored: String(error) };
      });
    if ('stopped' in verdict) return false;
    if ('errored' in verdict) {
      if (rolePolicy) {
        await review(`${partId}: automatic quality check was unavailable; preview the video and contact support if needed.`);
        return true;
      }
      await fail('check_failed', `${partId} output could not be checked: ${verdict.errored}`.slice(0, 500));
      return false;
    }
    if ('quality' in verdict && verdict.quality) {
      const quality = verdict.quality;
      deps.log?.('quality check v2', { jobId, part: partId, ...quality });
      if (quality.verdict === 'fail') {
        await fail('swap_not_applied_v2', `${partId}: original face remains across multiple visible frames; manual review required.`);
        return false;
      }
      if (quality.verdict === 'review') {
        await review(`${partId}: some faces may need checking; preview the video and contact support if needed.`);
      }
      return true;
    }
    // Compatibility with old images and previously cached step results.
    const worst = Math.max(0, ...verdict.scores);
    if (worst < check.maxSimilarity) return true;
    if (rolePolicy) {
      await review(`${partId}: legacy quality score ${worst}; preview the video and contact support if needed.`);
      return true;
    }
    deps.log?.('swap not applied', { jobId, part: partId, scores: verdict.scores });
    await fail('swap_not_applied', `${partId} still shows an original face (similarity ${worst})`);
    return false;
  };

  // Run prep segments first, then video segments (which use the prep results). Within a phase, submit one by one so segments render upstream in parallel, then poll in turn.
  // Idempotency key is jobId for single-part, jobId:segment ID for multi-part.
  for (const [from, to] of [
    [0, prepCount],
    [prepCount, partIds.length],
  ] as const) {
    for (let index = from; index < to; index++) {
      const partId = partIds[index]!;
      const submitted = await step.do(name('submit', partId), async () => {
        const job = await loadJob(deps.db, jobId);
        if (!job || TERMINAL.includes(job.status)) return { done: true as const };
        const existing = upstreamIds(job)[index];
        if (existing) return { upstreamJobId: existing };
        // Prep may have used up the time: submitting video segments now would just waste upstream spend.
        if (index > 0 && Date.now() > deadline) return { timeout: true as const };
                const submitStart = Date.now();
        try {
          const { upstreamJobId } = await adapter.submit(
            submitInput(job, index),
            single ? jobId : `${jobId}:${partId}`,
          );
          if (!(await appendUpstreamJob(deps.db, jobId, index, upstreamJobId))) {
            // The job was canceled during submit: nobody needs the task just placed, cancel it.
            await adapter.cancel(upstreamJobId).catch(() => undefined);
            return { done: true as const };
          }
                    deps.log?.('timing', { jobId, stage: 'submit', part: partId, ms: Date.now() - submitStart });
          return { upstreamJobId };
        } catch (error) {
          if (error instanceof UpstreamError && !error.retryable && index < prepCount) {
            // Prep rejected (e.g. a celebrity photo): don't fail, record a placeholder and fall back to the original photo.
            deps.log?.('prep rejected, using original photo', { jobId, part: partId, code: error.code });
            const skipped = `${SKIPPED}${partId}`;
            if (!(await appendUpstreamJob(deps.db, jobId, index, skipped))) return { done: true as const };
            return { upstreamJobId: skipped };
          }
          if (error instanceof UpstreamError && !error.retryable) {
            deps.log?.('upstream rejected job', {
              jobId,
              part: partId,
              code: error.code,
              message: error.message,
            });
            await cancelAll(adapter, upstreamIds(job));
            await markFailed(deps.db, jobId, 'failed', error.code, error.message);
            return { done: true as const };
          }
          throw error;
        }
      });
      if ('done' in submitted) return;
      if ('timeout' in submitted) {
        await timeOut();
        return;
      }
      submittedIds[index] = submitted.upstreamJobId;
    }

    let prepResults = new Map<string, Finished>();
    if (from === 0 && prepCount > 0) {
      const pending = partIds
        .slice(0, prepCount)
        .map((partId, index) => ({ partId, index, upstreamJobId: submittedIds[index]! }))
        .filter((part) => !part.upstreamJobId.startsWith(SKIPPED));
      if (pending.length > 0) {
        const polled = await pollPreps(pending);
        if (polled.state === 'stopped') return;
        if (polled.state === 'timeout') {
          await timeOut();
          return;
        }
        prepResults = polled.results;
      }
    }

    for (let index = from; index < to; index++) {
      const partId = partIds[index]!;
      const upstreamJobId = submittedIds[index]!;
      /** When prep yields no image (rejected, failed, empty result), fall back to the user's original photo instead of failing the job. */
      const fallBack = async () => {
        const original = await step.do(`prep-fallback:${partId}`, async () => {
          const job = await loadJob(deps.db, jobId);
          if (!job || TERMINAL.includes(job.status)) return null;
          const model = deps.models.find((m) => m.id === job.modelId)!;
          return partsOf(job, model)[index]!.references[0]!.url;
        });
        if (original) prepUrls.set(partId, original);
        return Boolean(original);
      };
      if (upstreamJobId.startsWith(SKIPPED)) {
        if (!(await fallBack())) return;
        continue;
      }
      const result =
        index < prepCount
          ? prepResults.get(partId)!
          : await pollUntilDone(upstreamJobId, single ? null : partId);
      if (result.state === 'stopped') return;
      if (result.state === 'failed') {
        if (index < prepCount) {
          deps.log?.('prep failed, using original photo', { jobId, part: partId, code: result.code });
          if (!(await fallBack())) return;
          continue;
        }
        await fail(result.code, result.message);
        return;
      }
      if (result.state === 'timeout') {
        await timeOut();
        return;
      }
      if (index < prepCount) {
        // Prep results are only reference images for later video segments; not stored or delivered.
        const url = result.files[0]?.url;
        if (url) prepUrls.set(partId, url);
        else if (!(await fallBack())) return;
        continue;
      }
      const start = outputs.length;
      const stored = await step.do(name('store', partId), async () => {
        const t = Date.now();
        const files = await storeOutputs(deps, jobId, result.files, start);
        deps.log?.('timing', { jobId, stage: 'store', part: partId, ms: Date.now() - t });
        return files;
      });
      if (stored[0]) partKeys.set(partId, stored[0].key);
      outputs.push(...stored);
      const check = setup.checks?.[partId];
      if (check && !(await verify(partId, index, check))) return;
    }
  }
  let finalOutputs = outputs;
  if (setup.compose) {
    // Compose failures throw: once Workflow retries run out the fallback fails the job with a full refund. Retries write the same keys, so it's idempotent.
      const composed = await step.do('compose', async () => {
      const t = Date.now();
      const result = await composeOutputs(deps, jobId, partKeys, outputs.length);
      deps.log?.('timing', { jobId, stage: 'compose', ms: Date.now() - t });
      return result;
    });
    if (!composed) return;
    finalOutputs = composed;
  }
  await step.do('finish', async () => {
    await markSucceeded(deps.db, jobId, finalOutputs);
    return true;
  });
}

/** Stitch the output in effect segment order: rendered segments use model outputs, the rest use base clips. Stored as a with-track and a silent file. */
async function composeOutputs(
  deps: RunnerDeps,
  jobId: string,
  partKeys: ReadonlyMap<string, string>,
  startIndex: number,
): Promise<StoredOutput[] | null> {
  const job = await loadJob(deps.db, jobId);
  if (!job || TERMINAL.includes(job.status)) return null;
  const model = deps.models.find((m) => m.id === job.modelId);
  const effect = model?.effect;
  if (!effect?.compose) throw new Error(`model ${job.modelId} has no compose config`);
  if (!deps.composer) throw new Error('compose is not configured for this site');
  // A job created under an older effect config (for example before its shots were merged into one) rendered segments the current
  // config no longer lists: composing would silently use base clips for them and deliver the original footage. Fail with a refund instead.
  const known = new Set(effect.segments.map((segment) => segment.id));
  const stale = partsOf(job, model!)
    .filter((part) => part.kind !== 'image' && !known.has(part.id))
    .map((part) => part.id);
  if (stale.length > 0) throw new Error(`segments ${stale.join(', ')} are no longer in the effect config`);
  const segments: ComposeSegment[] = effect.segments.map((segment) => {
    const rendered = partKeys.get(segment.id);
    // Shot cuts only apply to the model output; base clips already have the original timing.
    return rendered
      ? {
          key: rendered,
          target: segment.target!,
          fit: segment.fit ?? 'stretch',
          ...(segment.cuts ? { cuts: segment.cuts } : {}),
        }
      : { key: segment.base!, target: segment.target!, fit: 'stretch' };
  });
  const { audio, audioStart, audioDuration, width, height, fps } = effect.compose;
  const result = await deps.composer.compose({
    jobId,
    segments,
    audio: { key: audio, start: audioStart, duration: audioDuration },
    width,
    height,
    fps,
  });
  const song = `jobs/${jobId}/${startIndex}.mp4`;
  const silent = `jobs/${jobId}/${startIndex + 1}.mp4`;
  const meta = { httpMetadata: { contentType: 'video/mp4' } };
  await deps.bucket.put(song, result.song, meta);
  await deps.bucket.put(silent, result.silent, meta);
  return [
    { key: song, mediaType: 'video/mp4' },
    { key: silent, mediaType: 'video/mp4' },
  ];
}
