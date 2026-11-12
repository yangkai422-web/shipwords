-- Manual review queue: rendered jobs that are not a clear face-check pass (or whose compose failed) wait in status 'needs_review'
-- with credits still spent, until an admin approves (deliver) or rejects (refund once, error_code *_reviewed).
ALTER TABLE jobs ADD COLUMN review_json text;

-- One decision per job, with who and when (audit log; also makes repeated clicks a no-op).
CREATE TABLE IF NOT EXISTS job_reviews (
  job_id text PRIMARY KEY NOT NULL,
  action text NOT NULL,
  admin_email text NOT NULL,
  previous_code text,
  created_at integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status, created_at);

-- While a job of the same user and model waits for review, no new paid job of that model (temporary; ends with the decision).
CREATE TRIGGER IF NOT EXISTS jobs_review_pending_guard
BEFORE INSERT ON jobs
WHEN NEW.user_id IS NOT NULL
 AND NEW.cost_credits > 0
 AND EXISTS (
   SELECT 1 FROM jobs AS prior
   WHERE prior.user_id = NEW.user_id
     AND prior.model_id = NEW.model_id
     AND prior.status = 'needs_review'
 )
BEGIN
  SELECT RAISE(ABORT, 'review_pending');
END;
