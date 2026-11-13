import { loadDimensions, type TrafficDimensions } from './admin-dimensions';
import type { CleanVisitWindow } from './cf-clean-visits';

export const DAY = 86_400_000;
export const YIR_ESTIMATE_USD = 2.7378;
export const shanghaiDay = (now: number) => new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
export const maskEmail = (email: string | null) => {
  if (!email) return '访客 / 已删除账号';
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : '***';
};

export function dateRange(url: URL, now = Date.now()) {
  const days = url.searchParams.get('days') === '7' ? 7 : 30;
  const today = shanghaiDay(now);
  const startDefault = shanghaiDay(now - (days - 1) * DAY);
  const from = url.searchParams.get('from') || startDefault;
  const to = url.searchParams.get('to') || today;
  const valid = (s: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(`${s}T00:00:00+08:00`)) &&
    shanghaiDay(Date.parse(`${s}T00:00:00+08:00`)) === s;
  if (!valid(from) || !valid(to) || from > to || to > today) throw new Error('invalid_date_range');
  const start = Date.parse(`${from}T00:00:00+08:00`);
  const end = Date.parse(`${to}T00:00:00+08:00`) + DAY;
  if (end - start > 90 * DAY) throw new Error('date_range_too_long');
  return { from, to, start, end };
}

export type DateRange = ReturnType<typeof dateRange>;
export interface DailyRow {
  day: string;
  visitors: number | null;
  cfVisitors: number | null;
  cfPageViews: number | null;
  cfRequests: number | null;
  cleanVisits: number | null;
  cleanRequests: number | null;
  signups: number;
  orders: number;
  paidOrders: number;
  revenue: number;
  cashRefund: number;
  jobs: number;
  succeeded: number;
  review: number;
  failed: number;
  canceled: number;
  active: number;
  creditRefunds: number;
  generations: number;
  yirCost: number;
  knownCostJobs: number;
  estimatedCostJobs: number;
  margin: number;
}
// Reference column prefers first-party data even when its valid count is zero.
// Keep the two source totals separate: UTC zone uniques are not Shanghai browser uniques.
export function visitorReference(row: Pick<DailyRow, 'visitors' | 'cfVisitors'>) {
  if (row.visitors != null)
    return { value: row.visitors, source: 'first_party' as const, timeZone: 'Asia/Shanghai' as const };
  if (row.cfVisitors != null)
    return { value: row.cfVisitors, source: 'cloudflare' as const, timeZone: 'UTC' as const };
  return { value: null, source: 'unavailable' as const, timeZone: null };
}
export interface CloudflareHistory {
  from: string;
  to: string;
  fetchedAt: number;
  partialDays: string[];
  source: 'httpRequests1dGroups';
}
export interface RecentOrder {
  id: string;
  email: string | null;
  productId: string;
  status: string;
  amount: number;
  currency: string;
  createdAt: number;
  paidAt: number | null;
  sameAccountJobs: number;
  succeeded: number;
  review: number;
  failed: number;
  cashRefund: number;
}
export interface RecentJob {
  id: string;
  email: string | null;
  modelId: string;
  status: string;
  errorCode: string | null;
  createdAt: number;
  finishedAt: number | null;
  creditRefunded: number;
  held: number;
  outputCount: number;
  upstream: string;
  upstreamCost: string | null;
}
export interface HeldAccount {
  email: string | null;
  modelId: string;
  jobs: number;
  since: number;
}
export interface Dashboard {
  range: DateRange;
  trackingStartedAt: number | null;
  cfHistory: CloudflareHistory | null;
  cleanWindow: CleanVisitWindow | null;
  dimensions: TrafficDimensions;
  daily: DailyRow[];
  totals: Omit<DailyRow, 'day'>;
  orders: RecentOrder[];
  jobs: RecentJob[];
  held: HeldAccount[];
  /** Jobs waiting in the manual review queue (all time, not limited to the range). */
  pendingReviews: number;
  otherCurrencies: { currency: string; amount: number; orders: number }[];
}

const date = (column: string) => `date(${column}/1000, 'unixepoch', '+8 hours')`;
// Same conditions as the D1 triggers jobs_quality_retry_guard (permanent until *_reviewed); needs_review holds are temporary and counted separately.
const held = `j.status='failed' AND (j.error_code IN ('swap_not_applied','swap_not_applied_v2')
  OR (j.upstream_job_id IS NOT NULL AND j.error_code IN ('internal_error','stale','timeout','check_failed')))`;
// Segment IDs are recorded comma-separated; skipped prep slots are not paid generations.
const generations = `CASE WHEN upstream='yir' AND trim(coalesce(upstream_job_id,''))<>'' THEN
  max(0, 1+length(upstream_job_id)-length(replace(upstream_job_id,',',''))
  -(length(upstream_job_id)-length(replace(upstream_job_id,'skipped:','')))/8) ELSE 0 END`;

export async function loadDashboard(db: D1Database, range: DateRange): Promise<Dashboard> {
  const q = (sql: string, ...params: (number | string)[]) => db.prepare(sql).bind(...params);
  const result = await db.batch<Record<string, unknown>>([
    q("SELECT value FROM analytics_meta WHERE key='tracking_started_at'"),
    q(
      'SELECT day,count(*) visitors FROM daily_visitors WHERE day BETWEEN ? AND ? GROUP BY day',
      range.from,
      range.to,
    ),
    q(
      `SELECT ${date('created_at')} day,count(*) signups FROM user WHERE created_at>=? AND created_at<? GROUP BY day`,
      range.start,
      range.end,
    ),
    q(
      `SELECT ${date('created_at')} day,count(*) orders FROM orders WHERE created_at>=? AND created_at<? GROUP BY day`,
      range.start,
      range.end,
    ),
    q(
      `SELECT ${date('o.paid_at')} day,count(*) paidOrders,sum(o.amount)/100.0 revenue,
      sum(coalesce(p.refunded,0))/100.0 cashRefund FROM orders o LEFT JOIN
      (SELECT order_id,sum(amount_refunded) refunded FROM payments WHERE lower(currency)='usd' GROUP BY order_id) p ON p.order_id=o.id
      WHERE o.paid_at>=? AND o.paid_at<? AND lower(o.currency)='usd' GROUP BY day`,
      range.start,
      range.end,
    ),
    q(
      `WITH task AS (SELECT *,${generations} generations FROM jobs WHERE created_at>=? AND created_at<?)
      SELECT ${date('j.created_at')} day,count(*) jobs,
      sum(j.status='succeeded' AND coalesce(j.error_code,'')<>'quality_review') succeeded,
      sum((j.status='succeeded' AND j.error_code='quality_review') OR j.status='needs_review') review,
      sum(j.status='failed') failed,sum(j.status='canceled') canceled,
      sum(j.status IN ('queued','submitted')) active,
      sum(EXISTS(SELECT 1 FROM credit_ledger c WHERE c.idem_key='refund:job:'||j.id AND c.kind='refund')) creditRefunds,
      sum(generations) generations,
      sum(CASE WHEN upstream='yir' THEN coalesce(cast(nullif(upstream_cost_usd,'') AS REAL),generations*?) ELSE 0 END) yirCost,
      sum(upstream='yir' AND nullif(upstream_cost_usd,'') IS NOT NULL) knownCostJobs,
      sum(upstream='yir' AND nullif(upstream_cost_usd,'') IS NULL AND generations>0) estimatedCostJobs
      FROM task j GROUP BY day`,
      range.start,
      range.end,
      YIR_ESTIMATE_USD,
    ),
    q(
      `SELECT o.id,u.email,o.product_id productId,o.status,o.amount,o.currency,o.created_at createdAt,o.paid_at paidAt,
      (SELECT count(*) FROM jobs j WHERE j.user_id=o.user_id AND j.created_at>=? AND j.created_at<?) sameAccountJobs,
      (SELECT count(*) FROM jobs j WHERE j.user_id=o.user_id AND j.created_at>=? AND j.created_at<? AND j.status='succeeded' AND coalesce(j.error_code,'')<>'quality_review') succeeded,
      (SELECT count(*) FROM jobs j WHERE j.user_id=o.user_id AND j.created_at>=? AND j.created_at<? AND ((j.status='succeeded' AND j.error_code='quality_review') OR j.status='needs_review')) review,
      (SELECT count(*) FROM jobs j WHERE j.user_id=o.user_id AND j.created_at>=? AND j.created_at<? AND j.status='failed') failed,
      (SELECT coalesce(sum(p.amount_refunded),0) FROM payments p WHERE p.order_id=o.id) cashRefund
      FROM orders o LEFT JOIN user u ON u.id=o.user_id WHERE (o.created_at>=? AND o.created_at<?) OR (o.paid_at>=? AND o.paid_at<?)
      ORDER BY o.created_at DESC LIMIT 100`,
      range.start,
      range.end,
      range.start,
      range.end,
      range.start,
      range.end,
      range.start,
      range.end,
      range.start,
      range.end,
      range.start,
      range.end,
    ),
    q(
      `SELECT j.id,u.email,j.model_id modelId,j.status,j.error_code errorCode,j.created_at createdAt,j.finished_at finishedAt,
      j.upstream,j.upstream_cost_usd upstreamCost,
      EXISTS(SELECT 1 FROM credit_ledger c WHERE c.idem_key='refund:job:'||j.id AND c.kind='refund') creditRefunded,
      (${held}) held, CASE WHEN j.status='succeeded' AND json_valid(j.outputs_json) THEN json_array_length(j.outputs_json) ELSE 0 END outputCount
      FROM jobs j LEFT JOIN user u ON u.id=j.user_id WHERE j.created_at>=? AND j.created_at<? ORDER BY j.created_at DESC LIMIT 100`,
      range.start,
      range.end,
    ),
    q(`SELECT u.email,j.model_id modelId,count(*) jobs,min(j.created_at) since FROM jobs j LEFT JOIN user u ON u.id=j.user_id
      WHERE ${held} AND j.user_id IS NOT NULL GROUP BY j.user_id,j.model_id ORDER BY since DESC LIMIT 100`),
    q(
      `SELECT currency,sum(amount)/100.0 amount,count(*) orders FROM orders WHERE paid_at>=? AND paid_at<? AND lower(currency)<>'usd' GROUP BY currency`,
      range.start,
      range.end,
    ),
    q(
      'SELECT day_utc day,uniques cfVisitors,page_views cfPageViews,requests cfRequests FROM cf_daily_traffic WHERE day_utc BETWEEN ? AND ? ORDER BY day_utc',
      range.from,
      range.to,
    ),
    q(
      'SELECT min(day_utc) fromDay,max(day_utc) toDay,max(fetched_at) fetchedAt,group_concat(CASE WHEN is_partial=1 THEN day_utc END) partialDays FROM cf_daily_traffic',
    ),
    q("SELECT count(*) n FROM jobs WHERE status='needs_review'"),
    q(
      'SELECT day_utc day,visits cleanVisits,requests cleanRequests FROM cf_clean_visits WHERE day_utc BETWEEN ? AND ? ORDER BY day_utc',
      range.from,
      range.to,
    ),
    q(
      "SELECT visits,requests,bytes,window_start,window_end,fetched_at,last_error,last_attempt_at FROM cf_clean_visit_window WHERE id='last_24h'",
    ),
  ]);
  const rows = (index: number) => result[index]?.results ?? [];
  const started = rows(0)[0]?.value;
  const trackingStartedAt = typeof started === 'number' ? started : null;
  const daily: DailyRow[] = [];
  for (let t = range.start; t < range.end; t += DAY) {
    const day = shanghaiDay(t);
    daily.push({
      day,
      visitors:
        trackingStartedAt != null &&
        day >= shanghaiDay(trackingStartedAt) &&
        day >= shanghaiDay(Date.now() - 90 * DAY)
          ? 0
          : null,
      cfVisitors: null,
      cfPageViews: null,
      cfRequests: null,
      cleanVisits: null,
      cleanRequests: null,
      signups: 0,
      orders: 0,
      paidOrders: 0,
      revenue: 0,
      cashRefund: 0,
      jobs: 0,
      succeeded: 0,
      review: 0,
      failed: 0,
      canceled: 0,
      active: 0,
      creditRefunds: 0,
      generations: 0,
      yirCost: 0,
      knownCostJobs: 0,
      estimatedCostJobs: 0,
      margin: 0,
    });
  }
  const byDay = new Map(daily.map((row) => [row.day, row]));
  for (const batch of result.slice(1, 6))
    for (const values of batch.results) {
      const row = byDay.get(String(values.day));
      if (row) Object.assign(row, values);
    }
  for (const values of rows(10)) {
    const row = byDay.get(String(values.day));
    if (row) Object.assign(row, values);
  }
  const cfMeta = rows(11)[0];
  const cfHistory: CloudflareHistory | null =
    typeof cfMeta?.fromDay === 'string' &&
    typeof cfMeta.toDay === 'string' &&
    typeof cfMeta.fetchedAt === 'number'
      ? {
          from: cfMeta.fromDay,
          to: cfMeta.toDay,
          fetchedAt: cfMeta.fetchedAt,
          partialDays: typeof cfMeta.partialDays === 'string' ? cfMeta.partialDays.split(',') : [],
          source: 'httpRequests1dGroups',
        }
      : null;
  for (const values of rows(13)) {
    const row = byDay.get(String(values.day));
    if (row) Object.assign(row, values);
  }
  const windowRow = rows(14)[0];
  const cleanWindow: CleanVisitWindow | null = windowRow
    ? {
        visits: windowRow.visits == null ? null : Number(windowRow.visits),
        requests: windowRow.requests == null ? null : Number(windowRow.requests),
        bytes: windowRow.bytes == null ? null : Number(windowRow.bytes),
        windowStart: windowRow.window_start == null ? null : Number(windowRow.window_start),
        windowEnd: windowRow.window_end == null ? null : Number(windowRow.window_end),
        fetchedAt: windowRow.fetched_at == null ? null : Number(windowRow.fetched_at),
        lastError: typeof windowRow.last_error === 'string' ? windowRow.last_error : null,
        lastAttemptAt: windowRow.last_attempt_at == null ? null : Number(windowRow.last_attempt_at),
      }
    : null;
  for (const row of daily) row.margin = row.revenue - row.cashRefund - row.yirCost;
  const { day: _day, ...totals } = daily[0]!;
  for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
    if (
      key === 'visitors' ||
      key === 'cfVisitors' ||
      key === 'cfPageViews' ||
      key === 'cfRequests' ||
      key === 'cleanVisits' ||
      key === 'cleanRequests'
    )
      totals[key] = daily.every((d) => d[key] == null)
        ? null
        : daily.reduce((sum, d) => sum + (d[key] ?? 0), 0);
    else totals[key] = daily.reduce((sum, d) => sum + d[key], 0);
  }
  return {
    range,
    trackingStartedAt,
    cfHistory,
    cleanWindow,
    dimensions: await loadDimensions(db, range),
    daily: daily.reverse(),
    totals,
    orders: (rows(6) as unknown as RecentOrder[]).map((o) => ({ ...o, email: maskEmail(o.email) })),
    jobs: (rows(7) as unknown as RecentJob[]).map((j) => ({ ...j, email: maskEmail(j.email) })),
    held: (rows(8) as unknown as HeldAccount[]).map((h) => ({ ...h, email: maskEmail(h.email) })),
    pendingReviews: Number(rows(12)[0]?.n ?? 0),
    otherCurrencies: rows(9) as unknown as Dashboard['otherCurrencies'],
  };
}
