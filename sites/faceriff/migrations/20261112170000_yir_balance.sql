-- Yir wallet snapshots (GET /v1/balance), refreshed at most every 5 minutes by the admin dashboard and every 15 minutes by cron.
-- Amounts only (USD decimal strings); no key or account identifiers. Kept 30 days.
CREATE TABLE IF NOT EXISTS yir_balance_snapshots (
  fetched_at integer PRIMARY KEY NOT NULL,
  available text NOT NULL,
  held text NOT NULL,
  total text NOT NULL
);
