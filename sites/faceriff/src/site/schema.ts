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
