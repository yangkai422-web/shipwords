import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleAdminRequest, isAdmin, renderDashboard } from '../src/lib/admin.server';
import { dateRange, loadDashboard, maskEmail, shanghaiDay } from '../src/lib/admin-data';
import { isVisitorRequest, recordVisitor, visitorHash } from '../src/lib/visitors';

const secret = 'test-only-key-not-a-production-secret-1234';
const owner = { email: 'owner@example.com', emailVerified: true };
const adminEnv = { DB: env.DB, OUTPUTS: env.OUTPUTS, ADMIN_EMAILS: owner.email };
const now = Date.parse('2026-11-11T12:00:00+08:00');
const stamp = (s: string) => Date.parse(s);
const req = (path: string, method = 'GET') => new Request(`https://faceriff.com${path}`, { method });
const browser = (path = '/', ua = 'Mozilla/5.0 Chrome/140.0', ip = '192.0.2.3') =>
  new Request(`https://faceriff.com${path}`, { headers: { 'user-agent': ua, 'cf-connecting-ip': ip } });
const page = () =>
  new Response('<html>ok</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
const sql = (s: string, ...p: (string | number | null)[]) =>
  env.DB.prepare(s)
    .bind(...p)
    .run();
const range = () => dateRange(new URL('https://faceriff.com/admin?days=7'), now);
async function user() {
  await sql(
    "INSERT INTO user(id,name,email,email_verified,created_at) VALUES ('u','Customer','danger@example.com',1,?)",
    now,
  );
}
async function job(
  id: string,
  status: string,
  at = now,
  error: string | null = null,
  upstreamId: string | null = 'up_a',
  cost: string | null = null,
  outputs: string | null = null,
  model = 'tiny-desk',
) {
  await sql(
    "INSERT INTO jobs(id,user_id,model_id,kind,prompt,input_json,status,upstream,upstream_job_id,upstream_cost_usd,error_code,outputs_json,created_at) VALUES (?,'u',?,'video','private prompt','{}',?,'yir',?,?,?,?,?)",
    id,
    model,
    status,
    upstreamId,
    cost,
    error,
    outputs,
    at,
  );
}

beforeEach(async () => {
  for (const t of ['daily_visitors', 'analytics_meta', 'credit_ledger', 'payments', 'orders', 'jobs', 'user'])
    await sql(`DELETE FROM ${t}`);
});

describe('date windows and privacy helpers', () => {
  it('uses Shanghai midnight rather than UTC', () => {
    expect(shanghaiDay(stamp('2026-11-10T16:00:00Z'))).toBe('2026-11-11');
    const r = range();
    expect(r.from).toBe('2026-11-05');
    expect(r.to).toBe('2026-11-11');
    expect(r.start).toBe(stamp('2026-11-04T16:00:00Z'));
    expect(dateRange(new URL('https://faceriff.com/admin'), now).from).toBe('2026-10-13');
  });
  it('rejects invalid, reversed, future and unbounded dates', () => {
    for (const search of [
      'from=2026-02-30',
      'from=2026-11-11&to=2026-11-10',
      'to=2026-11-12',
      'from=2020-01-01',
    ]) {
      expect(() => dateRange(new URL(`https://faceriff.com/admin?${search}`), now)).toThrow();
    }
  });
  it('masks email local parts', () => {
    expect(maskEmail('danger@gmail.com')).toBe('d***@gmail.com');
    expect(maskEmail(null)).not.toContain('@');
  });
});

describe('visitor tracking', () => {
  it('accepts successful browser HTML only, excluding bots, APIs, admin and files', () => {
    expect(isVisitorRequest(browser(), page())).toBe(true);
    for (const path of [
      '/admin',
      '/admin/',
      '/api/admin/dashboard',
      '/api/auth/get-session',
      '/assets/app',
      '/media/demo.mp4',
      '/robots.txt',
      '/stats/event',
    ])
      expect(isVisitorRequest(browser(path), page())).toBe(false);
    for (const ua of ['Googlebot', 'curl/8.0', 'HeadlessChrome', 'facebookexternalhit'])
      expect(isVisitorRequest(browser('/', ua), page())).toBe(false);
    expect(isVisitorRequest(browser(), new Response('no', { status: 404 }))).toBe(false);
    expect(isVisitorRequest(req('/'), page())).toBe(false);
    expect(
      isVisitorRequest(
        new Request('https://faceriff.com/', {
          headers: { 'user-agent': 'Browser', 'cf-connecting-ip': '192.0.2.1', 'sec-purpose': 'prefetch' },
        }),
        page(),
      ),
    ).toBe(false);
  });
  it('HMAC changes across days, IPs, UAs and secrets', async () => {
    const h = await visitorHash(secret, '2026-11-11', '192.0.2.3', 'Browser');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    for (const args of [
      [secret, '2026-11-12', '192.0.2.3', 'Browser'],
      [secret, '2026-11-11', '192.0.2.4', 'Browser'],
      [secret, '2026-11-11', '192.0.2.3', 'Other'],
      ['other-secret', '2026-11-11', '192.0.2.3', 'Browser'],
    ]) {
      expect(await visitorHash(args[0]!, args[1]!, args[2]!, args[3]!)).not.toBe(h);
    }
  });
  it('deduplicates in D1, starts metadata once, prunes and stores no raw identifiers', async () => {
    await recordVisitor(env.DB, secret, browser(), now);
    await recordVisitor(env.DB, secret, browser(), now + 1000);
    expect((await env.DB.prepare('SELECT * FROM daily_visitors').all()).results).toEqual([
      {
        day: '2026-11-11',
        visitor_hash: await visitorHash(secret, '2026-11-11', '192.0.2.3', 'Mozilla/5.0 Chrome/140.0'),
      },
    ]);
    expect(
      await env.DB.prepare("SELECT value FROM analytics_meta WHERE key='tracking_started_at'").first('value'),
    ).toBe(now);
    await recordVisitor(env.DB, 'weak', browser(), now + 86_400_000);
    expect(await env.DB.prepare('SELECT count(*) n FROM daily_visitors').first('n')).toBe(1);
    await recordVisitor(env.DB, secret, browser(), now + 91 * 86_400_000);
    expect(await env.DB.prepare('SELECT count(*) n FROM daily_visitors').first('n')).toBe(1);
  });
});

describe('dashboard D1 aggregation', () => {
  it('renders empty history as unavailable, not fake zero visitors', async () => {
    const d = await loadDashboard(env.DB, range());
    expect(d.daily).toHaveLength(7);
    expect(d.totals.visitors).toBeNull();
    expect(d.totals.revenue).toBe(0);
    expect(renderDashboard(d)).toContain('未采集');
  });
  it('counts orders, refunds, outcomes and generations without double counting', async () => {
    await user();
    await sql(
      "INSERT INTO orders(id,user_id,product_id,provider,amount,currency,status,created_at,paid_at) VALUES ('o','u','video_1','paypal',988,'USD','paid',?,?)",
      stamp('2026-11-10T15:59:59Z'),
      stamp('2026-11-10T16:00:00Z'),
    );
    await sql(
      "INSERT INTO orders(id,user_id,product_id,provider,amount,currency,status,created_at) VALUES ('pending','u','video_1','paypal',988,'USD','pending',?)",
      now,
    );
    await sql(
      "INSERT INTO orders(id,user_id,product_id,provider,amount,currency,status,created_at,paid_at) VALUES ('eur','u','video_1','paypal',500,'eur','paid',?,?)",
      now,
      now,
    );
    await sql(
      "INSERT INTO payments(id,provider,payment_ref,user_id,order_id,product_id,amount,currency,amount_refunded) VALUES ('p','paypal','pay','u','o','video_1',988,'USD',100)",
    );
    await job(
      'job_ok',
      'succeeded',
      now,
      null,
      'up_a',
      '2.1',
      JSON.stringify([{ key: 'jobs/job_ok/0.mp4', mediaType: 'video/mp4' }]),
    );
    await job('job_review', 'succeeded', now, 'quality_review', 'up_a,skipped:prep,up_b');
    await job('job_fail', 'failed', now, 'swap_not_applied_v2', 'up_c', null, null, 'another-template');
    await job('job_early', 'failed', now, 'input_invalid', null);
    await job('job_active', 'queued', now, null, null);
    await sql(
      "INSERT INTO credit_ledger(id,user_id,kind,delta,idem_key) VALUES ('l','u','refund',10,'refund:job:job_fail')",
    );
    const d = await loadDashboard(env.DB, range());
    expect(d.totals).toMatchObject({
      signups: 1,
      orders: 3,
      paidOrders: 1,
      revenue: 9.88,
      cashRefund: 1,
      jobs: 5,
      succeeded: 1,
      review: 1,
      failed: 2,
      active: 1,
      creditRefunds: 1,
      generations: 4,
      knownCostJobs: 1,
      estimatedCostJobs: 2,
    });
    expect(d.totals.yirCost).toBeCloseTo(2.1 + 3 * 2.7378, 6);
    expect(d.totals.margin).toBeCloseTo(9.88 - 1 - d.totals.yirCost, 6);
    expect(d.daily.find((r) => r.day === '2026-11-10')).toMatchObject({ orders: 1, revenue: 0 });
    expect(d.daily.find((r) => r.day === '2026-11-11')).toMatchObject({ orders: 2, revenue: 9.88 });
    expect(d.otherCurrencies).toEqual([{ currency: 'eur', amount: 5, orders: 1 }]);
    expect(d.held).toMatchObject([{ email: 'd***@example.com', modelId: 'another-template', jobs: 1 }]);
    expect(d.orders.find((o) => o.id === 'o')).toMatchObject({
      sameAccountJobs: 5,
      succeeded: 1,
      review: 1,
      failed: 2,
      cashRefund: 100,
    });
    const html = renderDashboard(d);
    expect(html).not.toContain('danger@example.com');
    expect(html).not.toContain('private prompt');
    expect(html).toContain('/api/admin/output?job=job_ok');
  });
  it('includes historical holds but not reviewed failures', async () => {
    await user();
    await job('job_old', 'failed', now - 100 * 86_400_000, 'swap_not_applied');
    await job('job_reviewed', 'failed', now, 'swap_not_applied_reviewed', null);
    const d = await loadDashboard(env.DB, range());
    expect(d.held).toHaveLength(1);
    expect(d.held[0]?.since).toBe(now - 100 * 86_400_000);
  });
});

describe('server access and output protection', () => {
  it('requires a verified session and exact email allowlist', () => {
    expect(isAdmin(owner, ' OTHER@example.com, OWNER@EXAMPLE.COM ')).toBe(true);
    for (const u of [
      null,
      { ...owner, emailVerified: false },
      { ...owner, email: 'owner@example.com.attacker' },
    ])
      expect(isAdmin(u, owner.email)).toBe(false);
    expect(isAdmin(owner, undefined)).toBe(false);
  });
  it('returns 404 for every unauthorized admin surface before accessing D1 or R2', async () => {
    for (const path of [
      '/admin',
      '/admin/',
      '/admin/anything',
      '/api/admin',
      '/api/admin/dashboard',
      '/api/admin/output?job=job_ok',
    ]) {
      for (const u of [null, { ...owner, email: 'customer@example.com' }]) {
        const r = await handleAdminRequest(req(path), adminEnv, async () => u);
        expect(r?.status).toBe(404);
        expect(await r?.text()).toBe('Not found');
        expect(r?.headers.get('cache-control')).toContain('no-store');
      }
    }
    expect(
      await handleAdminRequest(req('/'), adminEnv, async () => {
        throw Error('must not run');
      }),
    ).toBeNull();
  });
  it('allows owner GET/HEAD, rejects writes, invalid dates, unknown routes', async () => {
    expect((await handleAdminRequest(req('/admin'), adminEnv, async () => owner))?.status).toBe(200);
    const api = await handleAdminRequest(req('/api/admin/dashboard'), adminEnv, async () => owner);
    expect(api?.status).toBe(200);
    expect(api?.headers.get('content-type')).toContain('application/json');
    const head = await handleAdminRequest(req('/admin', 'HEAD'), adminEnv, async () => owner);
    expect(await head?.text()).toBe('');
    expect((await handleAdminRequest(req('/admin', 'POST'), adminEnv, async () => owner))?.status).toBe(405);
    expect((await handleAdminRequest(req('/admin?from=invalid'), adminEnv, async () => owner))?.status).toBe(
      400,
    );
    expect((await handleAdminRequest(req('/api/admin/unknown'), adminEnv, async () => owner))?.status).toBe(
      404,
    );
    expect(
      (
        await handleAdminRequest(req('/admin'), adminEnv, async () => {
          throw Error('session down');
        })
      )?.status,
    ).toBe(503);
  });
  it('streams only successful jobs from their own R2 output prefix', async () => {
    await user();
    await job(
      'job_video',
      'succeeded',
      now,
      null,
      'up_v',
      null,
      JSON.stringify([{ key: 'jobs/job_video/0.mp4' }]),
    );
    await env.OUTPUTS.put('jobs/job_video/0.mp4', 'fake video bytes');
    const r = await handleAdminRequest(req('/api/admin/output?job=job_video'), adminEnv, async () => owner);
    expect(r?.status).toBe(200);
    expect(new TextDecoder().decode(await r?.arrayBuffer())).toBe('fake video bytes');
    expect(r?.headers.get('content-disposition')).toContain('attachment');
    await sql(
      "UPDATE jobs SET outputs_json=? WHERE id='job_video'",
      JSON.stringify([{ key: 'uploads/private-photo.jpg' }]),
    );
    expect(
      (await handleAdminRequest(req('/api/admin/output?job=job_video'), adminEnv, async () => owner))?.status,
    ).toBe(404);
    expect(
      (await handleAdminRequest(req('/api/admin/output?job=../private'), adminEnv, async () => owner))
        ?.status,
    ).toBe(404);
  });
});
