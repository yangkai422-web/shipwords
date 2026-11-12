import { refundSpend } from '@shipwords/core/credits/ledger';
import type { BatchItem, Db } from '@shipwords/core/db/client';
import { quotaCounters } from '@shipwords/core/db/schema';
import type { QuotaRule } from '@shipwords/core/quota/counters';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { type JobRow, jobs } from './schema';

// Every write to job state goes through here. Each state change is a conditional UPDATE;
// refunds and quota returns after failure or cancel settle on the final state, so they can be repeated and survive partial failure.

const ACTIVE: JobRow['status'][] = ['queued', 'submitted'];

export const spendKey = (jobId: string) => `job:${jobId}`;

/** Keep the video deliverable, but retain a visible quality warning after success. */
export async function markQualityReview(db: Db, jobId: string, message: string): Promise<void> {
  await db
    .update(jobs)
    .set({ errorCode: 'quality_review', errorMessage: message.slice(0, 500) })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ACTIVE)));
}

/** Failures after the upstream task was placed: we likely paid Yir, so a refunded retry needs support. */
export const PAID_FAILURE_CODES = ['internal_error', 'stale', 'timeout', 'check_failed'];

/** A failed paid quality check remains on hold until a human clears that job. */
export async function qualityRetryHold(db: Db, userId: string, modelId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.userId, userId),
      eq(jobs.modelId, modelId),
      eq(jobs.status, 'failed'),
      or(
        inArray(jobs.errorCode, ['swap_not_applied', 'swap_not_applied_v2']),
        // Yir was already asked to render, then we failed: refunded once, no free self-retry (keep in sync with the D1 trigger).
        and(isNotNull(jobs.upstreamJobId), inArray(jobs.errorCode, PAID_FAILURE_CODES)),
      ),
    ))
    .limit(1);
  return row?.id ?? null;
}

/** Drizzle/D1 may put the trigger message in an Error.cause chain. */
export function isQualityRetryHoldError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const item = current as { message?: unknown; cause?: unknown };
    if (typeof item.message === 'string' && item.message.includes('quality_review_required')) return true;
    current = item.cause;
  }
  return false;
}

export async function loadJob(db: Db, jobId: string): Promise<JobRow | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return row ?? null;
}

export async function markSubmitted(db: Db, jobId: string, upstreamJobId: string): Promise<boolean> {
  const result = await db
    .update(jobs)
    .set({ status: 'submitted', upstreamJobId, submittedAt: Date.now() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')))
    .run();
  return result.meta.changes > 0;
}

/** upstream_job_id stores upstream task IDs comma-separated in segment order; a single-part job has one ID. */
/** Placeholder ID recorded in a segment slot when the upstream rejects a prep submit: no upstream task, never polled or canceled. */
export const SKIPPED_UPSTREAM = 'skipped:';

export function upstreamIds(job: Pick<JobRow, 'upstreamJobId'>): string[] {
  return job.upstreamJobId ? job.upstreamJobId.split(',') : [];
}

/**
 * Record the upstream task ID for segment `index` (0-based). Segment 0 also advances the job to submitted;
 * later segments are appended only while the job is in progress and exactly the first `index` segments are recorded, so replays never duplicate or misalign.
 * Returns false if the job has ended (or was advanced elsewhere); the caller should cancel the upstream task it just submitted.
 */
export async function appendUpstreamJob(
  db: Db,
  jobId: string,
  index: number,
  upstreamJobId: string,
): Promise<boolean> {
  if (index === 0 && (await markSubmitted(db, jobId, upstreamJobId))) return true;
  const job = await loadJob(db, jobId);
  if (index === 0) return job?.status === 'submitted' && upstreamIds(job)[0] === upstreamJobId;
  if (job?.status !== 'submitted') return false;
  const ids = upstreamIds(job);
  if (ids[index] === upstreamJobId) return true;
  if (ids.length !== index) return false;
  const result = await db
    .update(jobs)
    .set({ upstreamJobId: [...ids, upstreamJobId].join(',') })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'submitted'), eq(jobs.upstreamJobId, job.upstreamJobId!)))
    .run();
  return result.meta.changes > 0;
}

export interface StoredOutput {
  key: string;
  mediaType: string;
}

export async function markSucceeded(db: Db, jobId: string, outputs: StoredOutput[]): Promise<boolean> {
  const result = await db
    .update(jobs)
    .set({ status: 'succeeded', outputsJson: JSON.stringify(outputs), finishedAt: Date.now() })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ACTIVE)))
    .run();
  return result.meta.changes > 0;
}

/** Record the upstream charge of an ended job; only bookkeeping, it never touches state or credits, so a re-read simply overwrites it. */
export async function recordUpstreamCost(db: Db, jobId: string, usd: string): Promise<void> {
  await db.update(jobs).set({ upstreamCostUsd: usd }).where(eq(jobs.id, jobId)).run();
}

/** Move an in-progress job to failed or canceled, then settle the refund. If the job already ended the state isn't changed, but settlement still runs. */
export async function markFailed(
  db: Db,
  jobId: string,
  status: 'failed' | 'canceled',
  code: string,
  message: string,
): Promise<JobRow | null> {
  await db
    .update(jobs)
    .set({ status, errorCode: code, errorMessage: message.slice(0, 500), finishedAt: Date.now() })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ACTIVE)));
  const job = await loadJob(db, jobId);
  if (job) await settleFailure(db, job);
  return job;
}

/**
 * Failed and canceled jobs: refund credits (idempotent). Failed guest jobs also return their quota (once); canceled ones don't, because the
 * upstream may already have charged us (a cancel just before the result lands), and returning it would let one guest loop create → cancel forever.
 * Succeeded jobs do nothing.
 */
export async function settleFailure(db: Db, job: JobRow): Promise<void> {
  if (job.status !== 'failed' && job.status !== 'canceled') return;
  if (job.costCredits > 0 && job.userId) {
    await refundSpend(db, {
      spendIdemKey: spendKey(job.id),
      idemKey: `refund:${spendKey(job.id)}`,
      ref: job.id,
    });
  }
  if (job.status === 'failed' && job.quotaJson && !job.quotaReleased) {
    // The quota decrements and the "returned" flag share one batch: each decrement is conditioned on the flag not being set,
    // so repeated calls return once, and a partial failure can't leave "flag set, count not returned".
    const notReleased = sql`exists (select 1 from ${jobs} where ${jobs.id} = ${job.id} and ${jobs.quotaReleased} = 0)`;
    const rules = JSON.parse(job.quotaJson) as QuotaRule[];
    const decrements = rules.map((rule) =>
      db
        .update(quotaCounters)
        .set({ count: sql`max(${quotaCounters.count} - 1, 0)` })
        .where(and(eq(quotaCounters.key, rule.key), eq(quotaCounters.window, rule.window), notReleased)),
    );
    // The flag must come last: the decrements above are conditioned on it not being set.
    const markReleased = db.update(jobs).set({ quotaReleased: true }).where(eq(jobs.id, job.id));
    const items: BatchItem[] = [...decrements, markReleased];
    await db.batch(items as [BatchItem, ...BatchItem[]]);
  }
}

/** After a guest signs in, move this device's guest jobs to the new account. */
export async function claimGuestJobs(db: Db, guestId: string, userId: string): Promise<void> {
  await db
    .update(jobs)
    .set({ userId })
    .where(and(eq(jobs.guestId, guestId), isNull(jobs.userId)))
    .run();
}
