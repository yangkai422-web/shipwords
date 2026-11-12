import type { Db } from '@shipwords/core/db/client';
import { and, eq } from 'drizzle-orm';
import { loadJob, settleFailure } from './lifecycle';
import { type JobRow, jobReviews, jobs } from './schema';

// Manual review queue: jobs the runner held in needs_review (face check not a clear pass, or compose failed after the model rendered).
// An admin either approves (deliver, credits stay spent) or rejects (fail with a *_reviewed code, refund once). Each decision is a
// conditional UPDATE from needs_review, so double clicks and retries can't apply it twice; the refund itself is idempotent too.

export type ReviewAction = 'approved' | 'rejected';

export type ReviewResult =
  | { ok: true; changed: boolean; job: JobRow }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'already_decided'; job: JobRow | null };

/** Rejected codes end in _reviewed, which the paid-failure guard and quality hold never match: a rejected customer can try again. */
export const reviewedCode = (code: string | null) =>
  `${code || 'review'}_reviewed`.replace(/(_reviewed)+$/, '_reviewed');

async function logDecision(
  db: Db,
  job: JobRow,
  action: ReviewAction,
  adminEmail: string,
  previousCode: string | null,
) {
  await db
    .insert(jobReviews)
    .values({ jobId: job.id, action, adminEmail: adminEmail.slice(0, 320), previousCode })
    .onConflictDoNothing()
    .run();
}

async function decided(db: Db, jobId: string) {
  const [row] = await db.select().from(jobReviews).where(eq(jobReviews.jobId, jobId)).limit(1);
  return row ?? null;
}

/**
 * Approve: deliver normally (succeeded, outputs served, usual success email via notify). Credits stay spent.
 * Repeating it on an already approved job is a no-op (changed=false) and sends nothing.
 */
export async function approveReview(
  db: Db,
  jobId: string,
  adminEmail: string,
  notify?: (job: JobRow) => Promise<void>,
): Promise<ReviewResult> {
  const before = await loadJob(db, jobId);
  if (!before) return { ok: false, reason: 'not_found', job: null };
  if (before.status !== 'needs_review') {
    const log = await decided(db, jobId);
    if (log?.action === 'approved' && before.status === 'succeeded')
      return { ok: true, changed: false, job: before };
    return { ok: false, reason: log ? 'already_decided' : 'not_pending', job: before };
  }
  const result = await db
    .update(jobs)
    .set({ status: 'succeeded', errorCode: null, errorMessage: null, finishedAt: Date.now() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'needs_review')))
    .run();
  const job = (await loadJob(db, jobId))!;
  if (result.meta.changes === 0) return approveReview(db, jobId, adminEmail, undefined);
  await logDecision(db, job, 'approved', adminEmail, before.errorCode);
  await notify?.(job).catch(() => undefined);
  return { ok: true, changed: true, job };
}

/**
 * Reject: fail with <code>_reviewed and refund the job's credits once (refundSpend is idempotent on refund:job:<id>).
 * Repeating it re-runs the idempotent settlement (finishing a refund that failed halfway) but never refunds or emails twice.
 */
export async function rejectReview(
  db: Db,
  jobId: string,
  adminEmail: string,
  notify?: (job: JobRow) => Promise<void>,
): Promise<ReviewResult> {
  const before = await loadJob(db, jobId);
  if (!before) return { ok: false, reason: 'not_found', job: null };
  if (before.status !== 'needs_review') {
    const log = await decided(db, jobId);
    if (log?.action === 'rejected' && before.status === 'failed') {
      await settleFailure(db, before);
      return { ok: true, changed: false, job: before };
    }
    return { ok: false, reason: log ? 'already_decided' : 'not_pending', job: before };
  }
  const result = await db
    .update(jobs)
    .set({
      status: 'failed',
      errorCode: reviewedCode(before.errorCode),
      errorMessage: 'Rejected after manual quality review; credits returned.',
      finishedAt: Date.now(),
    })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'needs_review')))
    .run();
  if (result.meta.changes === 0) return rejectReview(db, jobId, adminEmail, undefined);
  // Log before the refund: if the refund write fails, a retry finds the log and completes the idempotent settlement.
  await logDecision(db, before, 'rejected', adminEmail, before.errorCode);
  const job = (await loadJob(db, jobId))!;
  await settleFailure(db, job);
  await notify?.(job).catch(() => undefined);
  return { ok: true, changed: true, job };
}
