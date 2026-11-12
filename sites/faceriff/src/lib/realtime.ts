import { DAY, shanghaiDay } from './admin-data';
import type { VisitorDimension } from './visitor-dimensions';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
/** visitor_hits retention. */
export const REALTIME_RETENTION = 48 * HOUR;

// Public document routes only. Token routes collapse to a pattern; anything else is 'other' (never a raw path).
const PAGES = new Set([
  '/',
  '/account',
  '/billing/return',
  '/dmca',
  '/how-to-make-outstanding-tiny-desk-ai-video',
  '/login',
  '/outstanding-tiny-desk-ai-template',
  '/outstanding-tiny-desk-meme',
  '/pricing',
  '/privacy',
  '/refunds',
  '/terms',
  '/tiny-desk-ai-free',
]);
export function pageKey(pathname: string): string {
  const p = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  if (PAGES.has(p)) return p;
  if (/^\/phone\/[^/]+$/.test(p)) return '/phone/*';
  return 'other';
}

/** Statements appended to the visitor batch: one upserted minute row, the daily page-view counter, cheap prunes. */
export function realtimeStatements(
  db: D1Database,
  hash: string,
  pathname: string,
  dims: Record<VisitorDimension, string>,
  now: number,
): D1PreparedStatement[] {
  const minute = Math.floor(now / MINUTE);
  return [
    db
      .prepare('INSERT INTO analytics_meta(key,value) VALUES (?,?) ON CONFLICT DO NOTHING')
      .bind('realtime_started_at', now),
    db
      .prepare(
        `INSERT INTO visitor_hits(minute,visitor,path,country,device,os,browser,referrer) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(minute,visitor,path) DO UPDATE SET hits=visitor_hits.hits+1`,
      )
      .bind(
        minute,
        hash.slice(0, 16),
        pageKey(pathname),
        dims.country,
        dims.device,
        dims.os,
        dims.browser,
        dims.referrer,
      ),
    db
      .prepare(
        'INSERT INTO daily_pageviews(day,views) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET views=views+1',
      )
      .bind(shanghaiDay(now)),
    // Primary key starts with minute: an index range seek, normally zero or a handful of rows.
    db
      .prepare('DELETE FROM visitor_hits WHERE minute<?')
      .bind(Math.floor((now - REALTIME_RETENTION) / MINUTE)),
    db.prepare('DELETE FROM daily_pageviews WHERE day<?').bind(shanghaiDay(now - 90 * DAY)),
  ];
}

export interface CountRow {
  value: string;
  visitors: number;
}
export interface Realtime {
  now: number;
  startedAt: number | null;
  online5: number;
  online30: number;
  views5: number;
  views30: number;
  /** Average page views per minute over the last 5 minutes. */
  perMinute: number;
  /** Page views per minute, oldest first, 30 entries (current minute last, partial). */
  series: number[];
  pages: { path: string; visitors: number; views: number; active5: number }[];
  countries: CountRow[];
  devices: CountRow[];
}

export async function loadRealtime(db: D1Database, now = Date.now()): Promise<Realtime> {
  const m = Math.floor(now / MINUTE);
  const from30 = m - 29;
  const from5 = m - 4;
  const [meta, totals, series, pages, countries, devices] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT value FROM analytics_meta WHERE key='realtime_started_at'"),
    db
      .prepare(
        `SELECT count(DISTINCT CASE WHEN minute>=?1 THEN visitor END) online5,count(DISTINCT visitor) online30,
        coalesce(sum(CASE WHEN minute>=?1 THEN hits END),0) views5,coalesce(sum(hits),0) views30
        FROM visitor_hits WHERE minute>=?2 AND minute<=?3`,
      )
      .bind(from5, from30, m),
    db
      .prepare(
        'SELECT minute,sum(hits) views FROM visitor_hits WHERE minute>=? AND minute<=? GROUP BY minute',
      )
      .bind(from30, m),
    db
      .prepare(
        `SELECT path,count(DISTINCT visitor) visitors,sum(hits) views,count(DISTINCT CASE WHEN minute>=?1 THEN visitor END) active5
        FROM visitor_hits WHERE minute>=?2 AND minute<=?3 GROUP BY path ORDER BY active5 DESC,visitors DESC,views DESC,path LIMIT 20`,
      )
      .bind(from5, from30, m),
    db
      .prepare(
        'SELECT country value,count(DISTINCT visitor) visitors FROM visitor_hits WHERE minute>=? AND minute<=? GROUP BY country ORDER BY visitors DESC,value LIMIT 20',
      )
      .bind(from30, m),
    db
      .prepare(
        'SELECT device value,count(DISTINCT visitor) visitors FROM visitor_hits WHERE minute>=? AND minute<=? GROUP BY device ORDER BY visitors DESC,value',
      )
      .bind(from30, m),
  ]);
  const t = (totals?.results[0] ?? {}) as Record<string, number>;
  const perMin = new Map((series?.results ?? []).map((r) => [Number(r.minute), Number(r.views)]));
  const started = meta?.results[0]?.value;
  return {
    now,
    startedAt: typeof started === 'number' ? started : null,
    online5: Number(t.online5 ?? 0),
    online30: Number(t.online30 ?? 0),
    views5: Number(t.views5 ?? 0),
    views30: Number(t.views30 ?? 0),
    perMinute: Math.round((Number(t.views5 ?? 0) / 5) * 10) / 10,
    series: Array.from({ length: 30 }, (_, i) => perMin.get(from30 + i) ?? 0),
    pages: (pages?.results ?? []) as unknown as Realtime['pages'],
    countries: (countries?.results ?? []) as unknown as CountRow[],
    devices: (devices?.results ?? []) as unknown as CountRow[],
  };
}

export interface ChartDay {
  day: string;
  visitors: number | null;
  views: number | null;
  cfVisitors: number | null;
  cfViews: number | null;
  orders: number;
  paidOrders: number;
  succeeded: number;
  failed: number;
  review: number;
}
export interface Charts {
  /** 48 hourly buckets, oldest first; null before realtime collection started. */
  hourly: { hour: number; visitors: number | null; views: number | null }[];
  daily: ChartDay[];
  dimensions: { dimension: string; value: string; count: number }[];
  trackingStartedAt: number | null;
  realtimeStartedAt: number | null;
  fromDay: string;
  toDay: string;
}

const date = (column: string) => `date(${column}/1000, 'unixepoch', '+8 hours')`;

export async function loadCharts(db: D1Database, now = Date.now()): Promise<Charts> {
  const firstHour = Math.floor(now / HOUR) - 47;
  const toDay = shanghaiDay(now);
  const fromDay = shanghaiDay(now - 29 * DAY);
  const start = Date.parse(`${fromDay}T00:00:00+08:00`);
  const end = Date.parse(`${toDay}T00:00:00+08:00`) + DAY;
  const q = (sql: string, ...p: (string | number)[]) => db.prepare(sql).bind(...p);
  const [meta, hourly, visitors, views, cf, jobs, orders, paid, dims] = await db.batch<
    Record<string, unknown>
  >([
    q("SELECT key,value FROM analytics_meta WHERE key IN ('tracking_started_at','realtime_started_at')"),
    q(
      'SELECT minute/60 hour,count(DISTINCT visitor) visitors,sum(hits) views FROM visitor_hits WHERE minute>=? GROUP BY minute/60',
      firstHour * 60,
    ),
    q('SELECT day,count(*) n FROM daily_visitors WHERE day BETWEEN ? AND ? GROUP BY day', fromDay, toDay),
    q('SELECT day,views n FROM daily_pageviews WHERE day BETWEEN ? AND ?', fromDay, toDay),
    q(
      'SELECT day_utc day,uniques u,page_views v FROM cf_daily_traffic WHERE day_utc BETWEEN ? AND ?',
      fromDay,
      toDay,
    ),
    q(
      `SELECT ${date('created_at')} day,sum(status='succeeded') succeeded,sum(status='failed') failed,sum(status='needs_review') review
      FROM jobs WHERE created_at>=? AND created_at<? GROUP BY day`,
      start,
      end,
    ),
    q(
      `SELECT ${date('created_at')} day,count(*) n FROM orders WHERE created_at>=? AND created_at<? GROUP BY day`,
      start,
      end,
    ),
    q(
      `SELECT ${date('paid_at')} day,count(*) n FROM orders WHERE paid_at>=? AND paid_at<? GROUP BY day`,
      start,
      end,
    ),
    q(
      `SELECT dimension,value,sum(count) count FROM daily_visitor_dimensions WHERE day BETWEEN ? AND ?
      AND dimension IN ('country','device','os','browser','referrer') GROUP BY dimension,value ORDER BY count DESC,value`,
      fromDay,
      toDay,
    ),
  ]);
  const metaMap = new Map((meta?.results ?? []).map((r) => [String(r.key), Number(r.value)]));
  const realtimeStartedAt = metaMap.get('realtime_started_at') ?? null;
  const trackingStartedAt = metaMap.get('tracking_started_at') ?? null;
  const byDay = (rows: Record<string, unknown>[] | undefined) =>
    new Map((rows ?? []).map((r) => [String(r.day), r]));
  const hours = new Map((hourly?.results ?? []).map((r) => [Number(r.hour), r]));
  const vis = byDay(visitors?.results);
  const pv = byDay(views?.results);
  const cfd = byDay(cf?.results);
  const jd = byDay(jobs?.results);
  const od = byDay(orders?.results);
  const pd = byDay(paid?.results);
  const daily: ChartDay[] = [];
  for (let t = start; t < end; t += DAY) {
    const day = shanghaiDay(t);
    const tracked = trackingStartedAt != null && day >= shanghaiDay(trackingStartedAt);
    const viewsTracked = realtimeStartedAt != null && day >= shanghaiDay(realtimeStartedAt);
    daily.push({
      day,
      visitors: tracked ? Number(vis.get(day)?.n ?? 0) : null,
      views: viewsTracked ? Number(pv.get(day)?.n ?? 0) : null,
      cfVisitors: cfd.has(day) ? Number(cfd.get(day)?.u) : null,
      cfViews: cfd.has(day) ? Number(cfd.get(day)?.v) : null,
      orders: Number(od.get(day)?.n ?? 0),
      paidOrders: Number(pd.get(day)?.n ?? 0),
      succeeded: Number(jd.get(day)?.succeeded ?? 0),
      failed: Number(jd.get(day)?.failed ?? 0),
      review: Number(jd.get(day)?.review ?? 0),
    });
  }
  const startedHour = realtimeStartedAt == null ? null : Math.floor(realtimeStartedAt / HOUR);
  return {
    hourly: Array.from({ length: 48 }, (_, i) => {
      const hour = firstHour + i;
      const row = hours.get(hour);
      const live = startedHour != null && hour >= startedHour;
      return {
        hour,
        visitors: live ? Number(row?.visitors ?? 0) : null,
        views: live ? Number(row?.views ?? 0) : null,
      };
    }),
    daily,
    dimensions: (dims?.results ?? []) as unknown as Charts['dimensions'],
    trackingStartedAt,
    realtimeStartedAt,
    fromDay,
    toDay,
  };
}
