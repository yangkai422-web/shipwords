-- Paid-failure guard: once Yir was asked to render (upstream_job_id set) and the job still failed on our side
-- (store/compose crash, timeout, stale, unchecked output, or a clear swap miss), the refunded user cannot self-retry.
-- The Yir output usually sits in R2 at jobs/<id>/0.mp4; support delivers it or clears the hold by renaming error_code to *_reviewed.
DROP TRIGGER IF EXISTS jobs_quality_retry_guard;
CREATE TRIGGER jobs_quality_retry_guard
BEFORE INSERT ON jobs
WHEN NEW.user_id IS NOT NULL
 AND NEW.cost_credits > 0
 AND EXISTS (
   SELECT 1 FROM jobs AS prior
   WHERE prior.user_id = NEW.user_id
     AND prior.model_id = NEW.model_id
     AND prior.status = 'failed'
     AND (
       prior.error_code IN ('swap_not_applied', 'swap_not_applied_v2')
       OR (prior.upstream_job_id IS NOT NULL
           AND prior.error_code IN ('internal_error', 'stale', 'timeout', 'check_failed'))
     )
 )
BEGIN
  SELECT RAISE(ABORT, 'quality_review_required');
END;