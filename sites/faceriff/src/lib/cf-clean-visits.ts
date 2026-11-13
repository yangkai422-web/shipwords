/** Cloudflare Requests bookmark 「FaceRiff 干净访客」 — Adaptive visits, not first-party UV. */
export const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
export const DEFAULT_CF_ZONE_TAG = 'b24ec5ba31b1af31ad3afc70ae48e3f6';
export const CLEAN_VISIT_MAX_AGE = 15 * 60_000;
export const CLEAN_VISIT_TIMEOUT_MS = 8_000;
export const MIN_ANALYTICS_TOKEN_LENGTH = 32;
export const CLEAN_WINDOW_ID = 'last_24h';
const DAY = 86_400_000;
const RETAIN_DAYS = 120;
/** Adaptive daily lookback must stay at or under this zone's 4w2d GraphQL quota. */
export const CLEAN_DAILY_LOOKBACK_DAYS = 29;

export const CLEAN_VISIT_AND_FILTERS = [
  { clientRequestPath_notlike: '%/api/admin%' },
  { clientRequestPath_notlike: '%/sitemap.xml%' },
  { clientRequestPath_notlike: '%/robots.txt%' },
  { userAgentBrowser_neq: 'Curl' },
  { userAgentBrowser_neq: 'ChromeHeadless' },
] as const;

export const CLEAN_VISITS_QUERY = `query ($zone: String!, $windowFilter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!, $dailyFilter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      totals: httpRequestsAdaptiveGroups(limit: 1, filter: $windowFilter) {
        sum { visits edgeResponseBytes }
        count
      }
      byDate: httpRequestsAdaptiveGroups(limit: 100, orderBy: [date_ASC], filter: $dailyFilter) {
        dimensions { date }
        sum { visits edgeResponseBytes }
        count
      }
    }
  }
}`;

export interface CleanVisitEnv {
  DB: D1Database;
  CF_ANALYTICS_TOKEN?: string;
  CF_ZONE_TAG?: string;
}
export interface CleanVisitFilter {
  datetime_geq: string;
  datetime_lt: string;
  AND: typeof CLEAN_VISIT_AND_FILTERS;
}
export interface CleanDayRow {
  dayUtc: string;
  visits: number;
  requests: number;
  bytes: number;
}
export interface CleanVisitSnapshot {
  visits: number;
  requests: number;
  bytes: number;
  windowStart: number;
  windowEnd: number;
  days: CleanDayRow[];
}
export interface CleanVisitWindow {
  visits: number | null;
  requests: number | null;
  bytes: number | null;
  windowStart: number | null;
  windowEnd: number | null;
  fetchedAt: number | null;
  lastError: string | null;
  lastAttemptAt: number | null;
}
export interface CleanVisitVariables {
  zone: string;
  windowFilter: CleanVisitFilter;
  dailyFilter: CleanVisitFilter;
}
export type CleanVisitFetcher = (input: {
  zone: string;
  query: string;
  variables: CleanVisitVariables;
  token: string;
  signal: AbortSignal;
}) => Promise<unknown>;

export function isUsableAnalyticsToken(token: string | undefined): token is string {
  return typeof token === 'string' && token.trim().length >= MIN_ANALYTICS_TOKEN_LENGTH;
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function cleanVisitGroupFilter(datetimeGeq: string, datetimeLt: string): CleanVisitFilter {
  return {
    datetime_geq: datetimeGeq,
    datetime_lt: datetimeLt,
    AND: CLEAN_VISIT_AND_FILTERS,
  };
}

export function cleanVisitVariables(zone: string, now = Date.now()): CleanVisitVariables {
  const windowStart = now - DAY;
  const fromDaily = Date.parse(`${utcDay(now)}T00:00:00.000Z`) - CLEAN_DAILY_LOOKBACK_DAYS * DAY;
  return {
    zone,
    windowFilter: cleanVisitGroupFilter(new Date(windowStart).toISOString(), new Date(now).toISOString()),
    dailyFilter: cleanVisitGroupFilter(new Date(fromDaily).toISOString(), new Date(now).toISOString()),
  };
}

const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function mapCleanVisitResponse(body: unknown, windowStart: number, windowEnd: number): CleanVisitSnapshot {
  const zone = (body as { data?: { viewer?: { zones?: unknown[] } } })?.data?.viewer?.zones?.[0] as
    | {
        totals?: { sum?: { visits?: unknown; edgeResponseBytes?: unknown }; count?: unknown }[];
        byDate?: {
          dimensions?: { date?: unknown };
          sum?: { visits?: unknown; edgeResponseBytes?: unknown };
          count?: unknown;
        }[];
      }
    | undefined;
  if (!zone) throw new Error('graphql_empty');
  const totals = zone.totals?.[0];
  const days: CleanDayRow[] = [];
  for (const row of zone.byDate ?? []) {
    const dayUtc = String(row.dimensions?.date ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc)) continue;
    days.push({
      dayUtc,
      visits: num(row.sum?.visits),
      requests: num(row.count),
      bytes: num(row.sum?.edgeResponseBytes),
    });
  }
  return {
    visits: num(totals?.sum?.visits),
    requests: num(totals?.count),
    bytes: num(totals?.sum?.edgeResponseBytes),
    windowStart,
    windowEnd,
    days,
  };
}

const defaultFetcher: CleanVisitFetcher = async ({ token, query, variables, signal }) => {
  const response = await fetch(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!response.ok) throw new Error(`graphql_http_${response.status}`);
  const body = (await response.json()) as { errors?: { message?: unknown; extensions?: { code?: unknown } }[] };
  if (body.errors?.length) {
    const first = body.errors[0];
    const code = first?.extensions?.code ?? first?.message ?? 'graphql_error';
    throw new Error(String(code).slice(0, 80));
  }
  return body;
};

let inflight: Promise<void> | null = null;

async function recordError(db: D1Database, code: string, now: number) {
  await db
    .prepare(
      `INSERT INTO cf_clean_visit_window(id,visits,requests,bytes,window_start,window_end,fetched_at,last_error,last_attempt_at)
       VALUES ('${CLEAN_WINDOW_ID}',NULL,NULL,NULL,NULL,NULL,NULL,?,?)
       ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error,last_attempt_at=excluded.last_attempt_at`,
    )
    .bind(code.slice(0, 60), now)
    .run();
}

/** Refresh the snapshot if older than maxAge (single flight per isolate). Errors are returned, never thrown. */
export async function refreshCleanVisits(
  env: CleanVisitEnv,
  {
    now = Date.now(),
    maxAge = CLEAN_VISIT_MAX_AGE,
    fetcher = defaultFetcher,
    timeoutMs = CLEAN_VISIT_TIMEOUT_MS,
  } = {},
): Promise<string | null> {
  const last = await env.DB.prepare(
    `SELECT fetched_at t FROM cf_clean_visit_window WHERE id='${CLEAN_WINDOW_ID}'`,
  ).first<number>('t');
  if (last != null && now - last < maxAge) return null;
  const token = env.CF_ANALYTICS_TOKEN?.trim() ?? '';
  if (!isUsableAnalyticsToken(token)) {
    const code = token ? 'token_invalid' : 'not_configured';
    if (last == null) await recordError(env.DB, code, now);
    else
      await env.DB.prepare(
        `UPDATE cf_clean_visit_window SET last_error=?,last_attempt_at=? WHERE id='${CLEAN_WINDOW_ID}'`,
      )
        .bind(code, now)
        .run();
    return code;
  }
  const zone = env.CF_ZONE_TAG?.trim() || DEFAULT_CF_ZONE_TAG;
  const variables = cleanVisitVariables(zone, now);
  const windowStart = now - DAY;
  try {
    inflight ??= (async () => {
      const body = await fetcher({
        token,
        zone,
        query: CLEAN_VISITS_QUERY,
        variables,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const snap = mapCleanVisitResponse(body, windowStart, now);
      const today = utcDay(now);
      const statements = [
        env.DB.prepare(
          `INSERT INTO cf_clean_visit_window(id,visits,requests,bytes,window_start,window_end,fetched_at,last_error,last_attempt_at)
           VALUES (?,?,?,?,?,?,?,NULL,?)
           ON CONFLICT(id) DO UPDATE SET
             visits=excluded.visits,requests=excluded.requests,bytes=excluded.bytes,
             window_start=excluded.window_start,window_end=excluded.window_end,
             fetched_at=excluded.fetched_at,last_error=NULL,last_attempt_at=excluded.last_attempt_at`,
        ).bind(
          CLEAN_WINDOW_ID,
          snap.visits,
          snap.requests,
          snap.bytes,
          snap.windowStart,
          snap.windowEnd,
          now,
          now,
        ),
        ...snap.days.map((day) =>
          env.DB.prepare(
            `INSERT INTO cf_clean_visits(day_utc,visits,requests,bytes,fetched_at,is_partial)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(day_utc) DO UPDATE SET
               visits=excluded.visits,requests=excluded.requests,bytes=excluded.bytes,
               fetched_at=excluded.fetched_at,is_partial=excluded.is_partial`,
          ).bind(day.dayUtc, day.visits, day.requests, day.bytes, now, day.dayUtc === today ? 1 : 0),
        ),
        env.DB.prepare(`DELETE FROM cf_clean_visits WHERE day_utc<?`).bind(
          new Date(Date.parse(`${today}T00:00:00.000Z`) - RETAIN_DAYS * DAY).toISOString().slice(0, 10),
        ),
      ];
      await env.DB.batch(statements);
    })().finally(() => {
      inflight = null;
    });
    await inflight;
    return null;
  } catch (error) {
    const name = (error as Error)?.name;
    const code =
      name === 'TimeoutError' || name === 'AbortError'
        ? 'timeout'
        : String((error as Error)?.message ?? name ?? 'error').slice(0, 60);
    console.error(JSON.stringify({ event: 'cf_clean_visits_failed', code }));
    await recordError(env.DB, code, now);
    return code;
  }
}

/** If a snapshot already exists, refresh in the background; otherwise wait so the first view can show data. */
export async function maybeRefreshCleanVisits(
  env: CleanVisitEnv,
  {
    now = Date.now(),
    maxAge = CLEAN_VISIT_MAX_AGE,
    fetcher,
    timeoutMs,
    waitUntil,
  }: {
    now?: number;
    maxAge?: number;
    fetcher?: CleanVisitFetcher;
    timeoutMs?: number;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
): Promise<string | null> {
  const last = await env.DB.prepare(
    `SELECT fetched_at t FROM cf_clean_visit_window WHERE id='${CLEAN_WINDOW_ID}'`,
  ).first<number>('t');
  if (last != null && now - last < maxAge) return null;
  const work = refreshCleanVisits(env, { now, maxAge: 0, fetcher, timeoutMs });
  if (last != null && waitUntil) {
    waitUntil(work.then(() => undefined));
    return null;
  }
  return work;
}

export async function loadCleanVisitWindow(db: D1Database): Promise<CleanVisitWindow | null> {
  const row = await db
    .prepare(
      `SELECT visits,requests,bytes,window_start,window_end,fetched_at,last_error,last_attempt_at
       FROM cf_clean_visit_window WHERE id='${CLEAN_WINDOW_ID}'`,
    )
    .first<Record<string, unknown>>();
  if (!row) return null;
  const n = (key: string) => (row[key] == null ? null : num(row[key]));
  return {
    visits: n('visits'),
    requests: n('requests'),
    bytes: n('bytes'),
    windowStart: n('window_start'),
    windowEnd: n('window_end'),
    fetchedAt: n('fetched_at'),
    lastError: typeof row.last_error === 'string' ? row.last_error : null,
    lastAttemptAt: n('last_attempt_at'),
  };
}
