-- Realtime visitors (owner dashboard): one row per (minute, daily visitor, page), kept 48 hours.
-- visitor = first 16 hex chars of the existing daily HMAC (IP + UA + Shanghai day); no raw IP/UA, no cookie.
-- path = allowlisted public route ('/phone/*' for token pages, 'other' for everything else).
CREATE TABLE IF NOT EXISTS visitor_hits (
  minute integer NOT NULL,
  visitor text NOT NULL,
  path text NOT NULL,
  country text NOT NULL,
  device text NOT NULL,
  os text NOT NULL,
  browser text NOT NULL,
  referrer text NOT NULL,
  hits integer DEFAULT 1 NOT NULL,
  PRIMARY KEY (minute, visitor, path)
) WITHOUT ROWID;

-- First-party page views per Shanghai day (every qualifying HTML document request), kept 90 days.
CREATE TABLE IF NOT EXISTS daily_pageviews (
  day text PRIMARY KEY NOT NULL,
  views integer NOT NULL
);
