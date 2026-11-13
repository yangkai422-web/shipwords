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

// Marginal counts only: no dimension is attached to an individual daily pseudonym.
export const dailyVisitorDimensions = sqliteTable(
  'daily_visitor_dimensions',
  {
    day: text('day').notNull(),
    dimension: text('dimension').notNull(),
    value: text('value').notNull(),
    count: integer('count').notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.dimension, table.value] })],
);
export const cloudflareDailyDimensions = sqliteTable(
  'cf_daily_dimensions',
  {
    dayUtc: text('day_utc').notNull(),
    dataset: text('dataset').notNull(),
    dimension: text('dimension').notNull(),
    value: text('value').notNull(),
    count: integer('count').notNull(),
    fetchedAt: integer('fetched_at').notNull(),
    isPartial: integer('is_partial', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.dayUtc, table.dataset, table.dimension, table.value] })],
);

export const conversionEvents = sqliteTable('conversion_events', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  props: text('props').notNull().default('{}'),
  dedupeKey: text('dedupe_key'),
  createdAt: integer('created_at').notNull(),
  day: text('day').notNull(),
});

