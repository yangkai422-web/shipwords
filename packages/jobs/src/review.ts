import type { Db } from '@shipwords/core/db/client';
import { and, eq } from 'drizzle-orm';
import { loadJob, settleFailure } from './lifecycle';
import { type JobRow, jobReviews, jobs } from './schema';

// Manual review queue: jobs the runner held in needs_review (face check not a clear pass, or compose failed after the model rendered).
// An admin either approves (deliver, credits stay spent) or rejects (fail with a *_reviewed code, refund once). Each decision is a
// conditional UPDATE from needs_review, so double clicks and retries can't apply it twice; the refund itself is idempotent too.

export type ReviewAction = 'approved' | 'rejected';
type Notify = (job: JobRow) => Promise<void>;

export type ReviewResult =
  /** emailed: true sent, false the send failed (the decision still stands), null nothing was sent (no notifier, or a repeat). */
  | { ok: true; changed: boolean; job: JobRow; emailed: boolean | null }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'already_decided'; job: JobRow | null };

/** Rejected codes end in _reviewed, which the paid-failure guard and quality hold never match: a rejected customer can try again. */
export const reviewedCode = (code: string | null) =>
  `${code || 'review'}_reviewed`.replace(/(_reviewed)+$/, '_reviewed');

/** A rejection whose UPDATE landed: failed with a *_reviewed code on a job that went through review. */
const isReviewedRejection = (job: JobRow) =>
  job.status === 'failed' && job.reviewJson != null && (job.errorCode ?? '').endsWith('_reviewed');

async function logDecision(
  db: Db,
  jobId: string,
  action: ReviewAction,
  adminEmail: string,
  previousCode: string | null,
) {
  await db
    .insert(jobReviews)
    .values({ jobId, action, adminEmail: adminEmail.slice(0, 320), previousCode })
    .onConflictDoNothing()
    .run();
}

async function decided(db: Db, jobId: string) {
  const [row] = await db.select().from(jobReviews).where(eq(jobReviews.jobId, jobId)).limit(1);
  return row ?? null;
}

/** Best-effort customer email: a failure never undoes the decision, but is reported so the owner can follow up by hand. */
async function send(notify: Notify | undefined, job: JobRow): Promise<boolean | null> {
  if (!notify) return null;
  try {
    await notify(job);
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'review_email_failed',
        jobId: job.id,
        status: job.status,
        message: String(error).slice(0, 200),
      }),
    );
    return false;
  }
}

/**
 * Approve: deliver normally (succeeded, outputs served, usual success email via notify). Credits stay spent.
 * Repeating it on an already approved job is a no-op (changed=false) and sends nothing.
 */
export async function approveReview(
  db: Db,
  jobId: string,
  adminEmail: string,
  notify?: Notify,
): Promise<ReviewResult> {
  const before = await loadJob(db, jobId);
  if (!before) return { ok: false, reason: 'not_found', job: null };
  if (before.status !== 'needs_review') {
    const log = await decided(db, jobId);
    if (
      before.status === 'succeeded' &&
      (log?.action === 'approved' || (!log && before.reviewJson != null))
    ) {
      if (!log) await logDecision(db, jobId, 'approved', adminEmail, null);
      return { ok: true, changed: false, job: before, emailed: null };
    }
    return {
      ok: false,
      reason: log || isReviewedRejection(before) ? 'already_decided' : 'not_pending',
      job: before,
    };
  }
  const result = await db
    .update(jobs)
    .set({ status: 'succeeded', errorCode: null, errorMessage: null, finishedAt: Date.now() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'needs_review')))
    .run();
  if (result.meta.changes === 0) return approveReview(db, jobId, adminEmail);
  const job = (await loadJob(db, jobId))!;
  await logDecision(db, jobId, 'approved', adminEmail, before.errorCode);
  return { ok: true, changed: true, job, emailed: await send(notify, job) };
}

/**
 * Reject: fail with <code>_reviewed and refund the job's credits once (refundSpend is idempotent on refund:job:<id>).
 * Repeating it re-runs the idempotent settlement and writes a missing log (finishing a reject that failed halfway),
 * but never refunds or emails twice.
 */
export async function rejectReview(
  db: Db,
  jobId: string,
  adminEmail: string,
  notify?: Notify,
): Promise<ReviewResult> {
  const before = await loadJob(db, jobId);
  if (!before) return { ok: false, reason: 'not_found', job: null };
  if (before.status !== 'needs_review') {
    const log = await decided(db, jobId);
    if ((log?.action === 'rejected' && before.status === 'failed') || (!log && isReviewedRejection(before))) {
      await settleFailure(db, before);
      if (!log)
        await logDecision(
          db,
          jobId,
          'rejected',
          adminEmail,
          before.errorCode?.replace(/_reviewed$/, '') ?? null,
        );
      return { ok: true, changed: false, job: before, emailed: null };
    }
    return {
      ok: false,
      reason: log || before.status === 'succeeded' ? 'already_decided' : 'not_pending',
      job: before,
    };
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
  if (result.meta.changes === 0) return rejectReview(db, jobId, adminEmail);
  // Refund right after the state change; a retry here (or the customer's next read, healStale) completes it if this write fails.
  const job = (await loadJob(db, jobId))!;
  await settleFailure(db, job);
  await logDecision(db, jobId, 'rejected', adminEmail, before.errorCode);
  return { ok: true, changed: true, job, emailed: await send(notify, job) };
}
