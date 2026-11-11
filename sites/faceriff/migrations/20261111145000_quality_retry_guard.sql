-- Block refunded quality failures at INSERT time, inside the same credit-spend batch.
CREATE TRIGGER IF NOT EXISTS jobs_quality_retry_guard
BEFORE INSERT ON jobs
WHEN NEW.user_id IS NOT NULL
 AND NEW.cost_credits > 0
 AND EXISTS (
   SELECT 1 FROM jobs AS prior
   WHERE prior.user_id = NEW.user_id
     AND prior.model_id = NEW.model_id
     AND prior.status = 'failed'
     AND prior.error_code IN ('swap_not_applied', 'swap_not_applied_v2')
 )
BEGIN
  SELECT RAISE(ABORT, 'quality_review_required');
END;
