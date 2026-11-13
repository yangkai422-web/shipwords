-- Clean visits aligned with the Cloudflare Requests bookmark 「FaceRiff 干净访客」.
-- Rolling 24h snapshot plus UTC daily rows from httpRequestsAdaptiveGroups (sum.visits, count).
-- Does not replace or overwrite cf_daily_traffic (unfiltered historical import).
CREATE TABLE IF NOT EXISTS cf_clean_visits (
  day_utc text PRIMARY KEY NOT NULL,
  visits integer NOT NULL,
  requests integer NOT NULL,
  bytes integer NOT NULL,
  fetched_at integer NOT NULL,
  is_partial integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cf_clean_visit_window (
  id text PRIMARY KEY NOT NULL,
  visits integer,
  requests integer,
  bytes integer,
  window_start integer,
  window_end integer,
  fetched_at integer,
  last_error text,
  last_attempt_at integer NOT NULL
);
