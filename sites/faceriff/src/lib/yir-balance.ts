import { fetchYirBalance } from '@shipwords/jobs/yir-balance';
import { YIR_ESTIMATE_USD } from './admin-data';

export interface BalanceEnv {
  DB: D1Database;
  YIR_API_KEY?: string;
  YIR_BASE_URL?: string;
  /** Low-balance warning threshold in USD (default 10). The warning also fires below 5 jobs' worth. */
  YIR_LOW_BALANCE_USD?: string;
}
export type BalanceFetcher = (env: BalanceEnv) => Promise<{ available: string; held: string; total: string }>;
export interface YirBalanceView {
  available: number | null;
  held: number | null;
  total: number | null;
  fetchedAt: number | null;
  /** Last fetch failed; values (if any) are from the previous snapshot. */
  error: string | null;
  thresholdUsd: number;
  avgJobCost: number;
  /** Warning floor actually used: max(threshold, 5 jobs × average cost). */
  warnBelow: number;
  jobsLeft: number | null;
  low: boolean;
}
export const BALANCE_MAX_AGE = 5 * 60_000;
const defaultFetcher: BalanceFetcher = (env) =>
  fetchYirBalance({
    apiKey: env.YIR_API_KEY ?? '',
    ...(env.YIR_BASE_URL ? { baseURL: env.YIR_BASE_URL } : {}),
    signal: AbortSignal.timeout(8000),
  });
let inflight: Promise<void> | null = null;

/** Refresh the snapshot if older than maxAge (single flight per isolate). Errors are returned, never thrown. */
export async function refreshYirBalance(
  env: BalanceEnv,
  { now = Date.now(), maxAge = BALANCE_MAX_AGE, fetcher = defaultFetcher } = {},
): Promise<string | null> {
  const last = await env.DB.prepare('SELECT max(fetched_at) t FROM yir_balance_snapshots').first<number>('t');
  if (last != null && now - last < maxAge) return null;
  if (!env.YIR_API_KEY) return 'not_configured';
  try {
    inflight ??= (async () => {
      const b = await fetcher(env);
      const dec = /^-?\d+(\.\d+)?$/;
      if (![b.available, b.held, b.total].every((v) => dec.test(v)))
        throw new Error('balance_response_invalid');
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO yir_balance_snapshots(fetched_at,available,held,total) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
        ).bind(now, b.available, b.held, b.total),
        env.DB.prepare('DELETE FROM yir_balance_snapshots WHERE fetched_at<?').bind(now - 30 * 86_400_000),
      ]);
    })().finally(() => {
      inflight = null;
    });
    await inflight;
    return null;
  } catch (error) {
    const code = (error as { code?: string; status?: number })?.code ?? (error as Error)?.name ?? 'error';
    console.error(JSON.stringify({ event: 'yir_balance_failed', code }));
    return String(code).slice(0, 60);
  }
}

export async function loadYirBalance(
  env: BalanceEnv,
  options: Parameters<typeof refreshYirBalance>[1] = {},
): Promise<YirBalanceView> {
  const error = await refreshYirBalance(env, options);
  const [snap, cost] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      'SELECT fetched_at,available,held,total FROM yir_balance_snapshots ORDER BY fetched_at DESC LIMIT 1',
    ),
    // Average known Yir cost of the last 30 billed jobs (fallback: the recorded estimate).
    env.DB.prepare(
      "SELECT avg(c) avg FROM (SELECT CAST(upstream_cost_usd AS REAL) c FROM jobs WHERE upstream='yir' AND CAST(upstream_cost_usd AS REAL)>0 ORDER BY created_at DESC LIMIT 30)",
    ),
  ]);
  const s = snap?.results[0];
  const avg = Number(cost?.results[0]?.avg) || YIR_ESTIMATE_USD;
  const threshold = Number(env.YIR_LOW_BALANCE_USD);
  const thresholdUsd = Number.isFinite(threshold) && threshold >= 0 ? threshold : 10;
  const warnBelow = Math.max(thresholdUsd, 5 * avg);
  const available = s ? Number(s.available) : null;
  return {
    available,
    held: s ? Number(s.held) : null,
    total: s ? Number(s.total) : null,
    fetchedAt: s ? Number(s.fetched_at) : null,
    error,
    thresholdUsd,
    avgJobCost: Math.round(avg * 10000) / 10000,
    warnBelow: Math.round(warnBelow * 100) / 100,
    jobsLeft: available == null ? null : Math.max(0, Math.floor(available / avg)),
    low: available != null && available < warnBelow,
  };
}
