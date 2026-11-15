import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSucceededGenerationCountCache,
  getSucceededGenerationCount,
  parseSucceededGenerationCount,
  querySucceededGenerationCount,
  SUCCEEDED_GENERATION_COUNT_SQL,
} from '../src/lib/generation-count';

async function insertJob(id: string, status: string, cost = 10) {
  await env.DB.prepare(
    `INSERT INTO jobs (id, model_id, kind, prompt, input_json, cost_credits, status, upstream)
     VALUES (?, 'tiny-desk', 'video', '', '{}', ?, ?, 'yir')`,
  )
    .bind(id, cost, status)
    .run();
}

describe('succeeded generation count', () => {
  afterEach(() => {
    clearSucceededGenerationCountCache();
  });

  it('parses only a finite non-negative count', () => {
    expect(parseSucceededGenerationCount(null)).toBe(0);
    expect(parseSucceededGenerationCount({ n: 3 })).toBe(3);
    expect(parseSucceededGenerationCount({ n: 3.9 })).toBe(3);
    expect(parseSucceededGenerationCount({ n: -1 })).toBe(0);
    expect(parseSucceededGenerationCount({ n: Number.NaN })).toBe(0);
  });

  it('counts only succeeded jobs', async () => {
    expect(SUCCEEDED_GENERATION_COUNT_SQL).toContain("status = 'succeeded'");
    await insertJob('job_ok_1', 'succeeded');
    await insertJob('job_ok_2', 'succeeded');
    await insertJob('job_fail', 'failed');
    await insertJob('job_queue', 'queued', 0);
    expect(await querySucceededGenerationCount(env.DB)).toBe(2);
  });

  it('caches the count briefly', async () => {
    await insertJob('job_cache', 'succeeded');
    const first = await getSucceededGenerationCount(env.DB, 1_000);
    await insertJob('job_cache_2', 'succeeded');
    expect(await getSucceededGenerationCount(env.DB, 1_000 + 10_000)).toBe(first);
    expect(await getSucceededGenerationCount(env.DB, 1_000 + 61_000)).toBe(first + 1);
  });
});
