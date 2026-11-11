import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Cookie-free daily pseudonyms; no IP, user-agent, path, or cross-day identifier is stored.
export const dailyVisitors = sqliteTable(
  'daily_visitors',
  {
    day: text('day').notNull(),
    visitorHash: text('visitor_hash').notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.visitorHash] })],
);

export const analyticsMeta = sqliteTable('analytics_meta', {
  key: text('key').primaryKey(),
  value: integer('value').notNull(),
});

// Imported zone-level aggregates only. UTC dates must not be relabelled as Shanghai dates.
export const cloudflareDailyTraffic = sqliteTable('cf_daily_traffic', {
  dayUtc: text('day_utc').primaryKey(),
  uniques: integer('uniques').notNull(),
  pageViews: integer('page_views').notNull(),
  requests: integer('requests').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
  isPartial: integer('is_partial', { mode: 'boolean' }).notNull().default(false),
});
