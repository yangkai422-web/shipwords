import type { DateRange } from './admin-data';
export interface DimensionCount {
  dimension: string;
  value: string;
  count: number;
  dataset: string;
}
export interface DimensionCoverage {
  dataset: string;
  dimension: string;
  fromDay: string;
  toDay: string;
  days: number;
  fetchedAt: number;
  partialDays: string | null;
}
export interface TrafficDimensions {
  startedAt: number | null;
  firstParty: DimensionCount[];
  cloudflare: DimensionCount[];
  coverage: DimensionCoverage[];
}
export async function loadDimensions(db: D1Database, range: DateRange): Promise<TrafficDimensions> {
  const [meta, first, cf, coverage] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT value FROM analytics_meta WHERE key='dimensions_started_at'"),
    db
      .prepare(
        "SELECT dimension,value,sum(count) count,'first_party' dataset FROM daily_visitor_dimensions WHERE day BETWEEN ? AND ? GROUP BY dimension,value ORDER BY count DESC,value",
      )
      .bind(range.from, range.to),
    db
      .prepare(
        'SELECT dataset,dimension,value,sum(count) count FROM cf_daily_dimensions WHERE day_utc BETWEEN ? AND ? GROUP BY dataset,dimension,value ORDER BY count DESC,value',
      )
      .bind(range.from, range.to),
    db.prepare(
      'SELECT dataset,dimension,min(day_utc) fromDay,max(day_utc) toDay,count(DISTINCT day_utc) days,max(fetched_at) fetchedAt,group_concat(DISTINCT CASE WHEN is_partial=1 THEN day_utc END) partialDays FROM cf_daily_dimensions GROUP BY dataset,dimension ORDER BY dataset,dimension',
    ),
  ]);
  const started = meta?.results[0]?.value;
  return {
    startedAt: typeof started === 'number' ? started : null,
    firstParty: (first?.results ?? []) as unknown as DimensionCount[],
    cloudflare: (cf?.results ?? []) as unknown as DimensionCount[],
    coverage: (coverage?.results ?? []) as unknown as DimensionCoverage[],
  };
}
