import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleAdminRequest } from '../src/lib/admin.server';
import { liveJson, loadLive } from '../src/lib/admin-live';
import { loadYirBalance, refreshYirBalance } from '../src/lib/yir-balance';

const owner = { email: 'owner@example.com', emailVerified: true };
const adminEnv = { DB: env.DB, OUTPUTS: env.OUTPUTS, ADMIN_EMAILS: owner.email };
const req = (path: string) => new Request(`https://faceriff.com${path}`);
const sql = (s: string, ...p: (string | number | null)[]) =>
  env.DB.prepare(s)
    .bind(...p)
    .run();
const now = Date.now();

beforeEach(async () => {
  for (const t of [
    'yir_balance_snapshots',
    'payments',
    'orders',
    'jobs',
    'daily_visitors',
    'visitor_hits',
    'user',
  ])
    await sql(`DELETE FROM ${t}`);
  await sql(
    "INSERT INTO user(id,name,email,email_verified,created_at) VALUES ('u','C','buyer@example.com',1,?)",
    now - 86_400_000,
  );
});
async function order(id: string, status: string, at: number, paidAt: number | null, refunded = 0) {
  await sql(
    "INSERT INTO orders(id,user_id,product_id,provider,amount,currency,status,created_at,paid_at) VALUES (?,'u','video_3','paypal',2499,'USD',?,?,?)",
    id,
    status,
    at,
    paidAt,
  );
  if (refunded)
    await sql(
      "INSERT INTO payments(id,provider,payment_ref,user_id,order_id,product_id,amount,currency,amount_refunded) VALUES (?,'paypal',?,'u',?,'video_3',2499,'USD',?)",
      `pay_${id}`,
      `ref_${id}`,
      id,
      refunded,
    );
}
async function job(
  id: string,
  status: string,
  at: number,
  code: string | null = null,
  cost: string | null = null,
) {
  await sql(
    "INSERT INTO jobs(id,user_id,model_id,kind,prompt,input_json,status,upstream,upstream_job_id,upstream_cost_usd,error_code,created_at) VALUES (?,'u','tiny-desk','video','p','{}',?,'yir','up',?,?,?)",
    id,
    status,
    cost,
    code,
    at,
  );
}

describe('live orders and jobs', () => {
  it('lists recent orders and jobs with full email, package, status and Yir cost; today summary', async () => {
    await order('o_paid', 'paid', now - 60_000, now - 50_000);
    await order('o_pending', 'pending', now - 30_000, null);
    await order('o_refunded', 'paid', now - 90_000, now - 80_000, 2499);
    await job('j_review', 'needs_review', now - 10_000, 'face_check_low', '2.7378');
    await job('j_ok', 'succeeded', now - 20_000, null, '2.80');
    await job('j_bad', 'failed', now - 40_000, 'internal_error');
    const j = liveJson(await loadLive(env.DB, now), null);
    expect(j.orders.map((r) => [r[1]?.t, r[2]?.t, r[3]?.t, r[4]?.t])).toEqual([
      ['buyer@example.com', '3 videos', 'USD 24.99', '待付款'],
      ['buyer@example.com', '3 videos', 'USD 24.99', '已付款'],
      ['buyer@example.com', '3 videos', 'USD 24.99', '已退款'],
    ]);
    expect(j.jobs[0]?.[3]).toEqual({ t: '待审核 →', c: 'bad', href: '/admin/review' });
    expect(j.jobs.map((r) => [r[4]?.t, r[5]?.t])).toEqual([
      ['face_check_low', '$2.74'],
      ['—', '$2.80'],
      ['internal_error', '—'],
    ]);
    expect(j.pendingReviews).toBe(1);
    expect(j.yir.value).toBe('不可用');
  });
  it('JSON endpoint is admin-only, uncached and never contains the API key', async () => {
    for (const u of [null, { ...owner, email: 'customer@example.com' }]) {
      const r = await handleAdminRequest(req('/api/admin/live'), adminEnv, async () => u);
      expect(r?.status).toBe(404);
      expect(r?.headers.get('cache-control')).toContain('no-store');
    }
    const r = await handleAdminRequest(
      req('/api/admin/live'),
      { ...adminEnv, YIR_API_KEY: 'yir_test_secret_key_value' },
      async () => owner,
    );
    expect(r?.status).toBe(200);
    expect(r?.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    const text = (await r?.text()) ?? '';
    expect(text).not.toContain('yir_test_secret_key_value');
    expect(JSON.parse(text)).toHaveProperty('summary');
  });
});

describe('Yir balance', () => {
  const benv = { DB: env.DB, YIR_API_KEY: 'k' };
  it('caches for 5 minutes, then refreshes; computes jobs left and warns below max($10, 5 jobs)', async () => {
    await job('j1', 'succeeded', now - 1000, null, '3.00');
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { available: calls === 1 ? '50.00' : '12.00', held: '2.74', total: '52.74' };
    };
    let y = await loadYirBalance(benv, { now, fetcher });
    expect(y).toMatchObject({
      available: 50,
      held: 2.74,
      jobsLeft: 16,
      avgJobCost: 3,
      warnBelow: 15,
      low: false,
      error: null,
    });
    y = await loadYirBalance(benv, { now: now + 4 * 60_000, fetcher });
    expect(calls).toBe(1);
    y = await loadYirBalance(benv, { now: now + 6 * 60_000, fetcher });
    expect(calls).toBe(2);
    expect(y).toMatchObject({ available: 12, jobsLeft: 4, low: true, fetchedAt: now + 6 * 60_000 });
    expect(liveJson(await loadLive(env.DB, now), y).yir.warn).toContain('Yir 余额偏低');
    const custom = await loadYirBalance(
      { ...benv, YIR_LOW_BALANCE_USD: '100' },
      { now: now + 7 * 60_000, fetcher },
    );
    expect(custom).toMatchObject({ thresholdUsd: 100, warnBelow: 100, low: true });
  });
  it('keeps the last snapshot on errors, rejects malformed answers, and reports missing configuration', async () => {
    expect(await refreshYirBalance({ DB: env.DB }, { now })).toBe('not_configured');
    await loadYirBalance(benv, {
      now,
      fetcher: async () => ({ available: '20.5', held: '0', total: '20.5' }),
    });
    const failed = await loadYirBalance(benv, {
      now: now + 10 * 60_000,
      fetcher: async () => {
        throw Object.assign(new Error('nope'), { code: 'YIR_UNAUTHORIZED' });
      },
    });
    expect(failed).toMatchObject({ available: 20.5, error: 'YIR_UNAUTHORIZED', fetchedAt: now });
    expect(liveJson(await loadLive(env.DB, now), failed).yir.note).toContain('刷新失败');
    const bad = await refreshYirBalance(benv, {
      now: now + 20 * 60_000,
      fetcher: async () => ({ available: 'lots', held: '0', total: '0' }),
    });
    expect(bad).toBe('Error');
    expect(await env.DB.prepare('SELECT count(*) n FROM yir_balance_snapshots').first('n')).toBe(1);
  });
});

describe('simplified dashboard layout', () => {
  it('puts orders and jobs first, KPIs next, and everything else in closed sections', async () => {
    await sql(
      "INSERT INTO yir_balance_snapshots(fetched_at,available,held,total) VALUES (?, '3.10', '0', '3.10')",
      Date.now(),
    );
    const r = await handleAdminRequest(req('/admin'), adminEnv, async () => owner);
    const page = (await r?.text()) ?? '';
    const pos = (s: string) => page.indexOf(s);
    expect(pos('最近订单')).toBeGreaterThan(0);
    expect(pos('最近订单')).toBeLessThan(pos('最近生成任务'));
    expect(pos('最近生成任务')).toBeLessThan(pos('Yir 余额（可用）'));
    expect(pos('Yir 余额（可用）')).toBeLessThan(pos('<details'));
    expect(page).toContain('Yir 余额偏低');
    expect(page).toContain('id="k-yir">$3.10<');
    expect(page).not.toMatch(/<details[^>]*\sopen/);
    for (const s of ['实时访客详情', '趋势图表', '转化事件', '本地化决策', '经营明细', '访客来源明细', '指标口径与限制'])
      expect(page).toContain(`<summary>${s}`);
    expect(page).toContain('/api/admin/live');
    // Auto-refresh every 2 hours while visible, pause when hidden, fetch immediately when the tab returns; never every 30 s.
    expect(page).not.toContain('30 秒');
    expect(page).not.toMatch(/,30000\)/);
    expect(page.split('setInterval(tick,7200000)').length - 1).toBe(2);
    expect(page.split('document.hidden?stop():start(true)').length - 1).toBe(2);
    expect(page.split('每 2 小时自动刷新').length - 1).toBe(2);
    expect(page).toContain('转化事件（今日');
    for (const script of page.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g) ?? [])
      expect(() => new Function(script.replace(/^<script[^>]*>|<\/script>$/g, ''))).not.toThrow();
    const ranged = await (
      await handleAdminRequest(req('/admin?days=30'), adminEnv, async () => owner)
    )?.text();
    expect(ranged).toMatch(/<details class="sec" open><summary>经营明细/);
  });
});
