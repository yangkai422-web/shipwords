/**
 * Public homepage count: successful FaceRiff renders in D1.
 * Only `succeeded` jobs are counted — never invented or rounded up.
 */
export const SUCCEEDED_GENERATION_COUNT_SQL = `SELECT COUNT(*) AS n FROM jobs WHERE status = 'succeeded'`;

export type GenerationCountRow = { n: number };

export type D1Countable = {
  prepare: (sql: string) => { first: <T = Record<string, unknown>>() => Promise<T | null> };
};

/** Treat missing, NaN, or negative counts as zero so the homepage never inflates the number. */
export function parseSucceededGenerationCount(row: GenerationCountRow | null | undefined): number {
  const n = Number(row?.n ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

export async function querySucceededGenerationCount(db: D1Countable): Promise<number> {
  const row = await db.prepare(SUCCEEDED_GENERATION_COUNT_SQL).first<GenerationCountRow>();
  return parseSucceededGenerationCount(row);
}

const TTL_MS = 60_000;
let cache: { value: number; at: number } | null = null;

export function clearSucceededGenerationCountCache() {
  cache = null;
}

export async function getSucceededGenerationCount(db: D1Countable, now = Date.now()): Promise<number> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const value = await querySucceededGenerationCount(db);
  cache = { value, at: now };
  return value;
}
