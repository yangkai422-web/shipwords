import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

/**
 * Generation jobs. State only moves forward: queued → submitted → succeeded | failed | canceled, or submitted → needs_review → succeeded | failed;
 * every state change is a conditional UPDATE, so a finished job can never be moved to another state.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    /** Signed-in users' jobs have userId; guest jobs only have guestId, and userId is filled in when claimed after sign-in. */
    userId: text('user_id'),
    guestId: text('guest_id'),
    modelId: text('model_id').notNull(),
    kind: text('kind', { enum: ['image', 'video'] }).notNull(),
    prompt: text('prompt').notNull(),
    inputJson: text('input_json').notNull(),
    costCredits: integer('cost_credits').notNull().default(0),
    /** Guest quota counting rule, used to return quota on failure. */
    quotaJson: text('quota_json'),
    quotaReleased: integer('quota_released', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['queued', 'submitted', 'needs_review', 'succeeded', 'failed', 'canceled'] })
      .notNull()
      .default('queued'),
    upstream: text('upstream').notNull(),
    upstreamJobId: text('upstream_job_id'),
    /** What the upstream actually charged (USD string), summed over every upstream task; null until read or when the upstream doesn't report it. */
    upstreamCostUsd: text('upstream_cost_usd'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** Manual review details (face-check scores, reasons, raw output key) for jobs held in needs_review; kept after the decision. */
    reviewJson: text('review_json'),
    /** R2 key and content type of the output. */
    outputsJson: text('outputs_json'),
    createdAt: integer('created_at', { mode: 'number' }).notNull().default(now),
    submittedAt: integer('submitted_at', { mode: 'number' }),
    finishedAt: integer('finished_at', { mode: 'number' }),
  },
  (t) => [
    index('jobs_user_idx').on(t.userId, t.createdAt),
    index('jobs_guest_idx').on(t.guestId, t.createdAt),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
export type JobStatus = JobRow['status'];
/** States in which the runner stops working on a job. needs_review is final for the runner; only an admin decision moves it on. */
export const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'canceled', 'needs_review'];

/** One admin decision per held job (approve or reject), with who and when. */
export const jobReviews = sqliteTable('job_reviews', {
  jobId: text('job_id').primaryKey(),
  action: text('action', { enum: ['approved', 'rejected'] }).notNull(),
  adminEmail: text('admin_email').notNull(),
  previousCode: text('previous_code'),
  createdAt: integer('created_at', { mode: 'number' }).notNull().default(now),
});
