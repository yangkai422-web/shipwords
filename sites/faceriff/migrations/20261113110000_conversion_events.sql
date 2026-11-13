-- First-party conversion events for the owner dashboard (GA4/Umami may be absent).
-- No IP, user-agent, or email is stored. Optional dedupe_key prevents double-counts.
CREATE TABLE IF NOT EXISTS conversion_events (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  props text NOT NULL DEFAULT '{}',
  dedupe_key text,
  created_at integer NOT NULL,
  day text NOT NULL
);
CREATE INDEX IF NOT EXISTS conversion_events_day_name ON conversion_events(day, name, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS conversion_events_dedupe ON conversion_events(name, dedupe_key) WHERE dedupe_key IS NOT NULL;
