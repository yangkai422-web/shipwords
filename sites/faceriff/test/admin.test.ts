import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleAdminRequest, isAdmin, renderDashboard } from '../src/lib/admin.server';
import { loadReviewQueue, renderReviewPage } from '../src/lib/admin-review';
import { dateRange, loadDashboard, maskEmail, shanghaiDay, visitorReference } from '../src/lib/admin-data';
import { referrerPlatform, visitorDimensions } from '../src/lib/visitor-dimensions';
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
  for (const t of [
    'daily_visitor_dimensions',
    'cf_daily_dimensions',
    'cf_daily_traffic',
    'daily_visitors',
    'analytics_meta',
    'job_reviews',
    'credit_ledger',
    'payments',
    'orders',
    'jobs',
    'user',
  ])
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
  it('redirects anonymous dashboard visits but denies data and signed-in non-admins before D1 or R2', async () => {
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
        const redirect = u == null && ['/admin', '/admin/'].includes(path);
        expect(r?.status).toBe(redirect ? 302 : 404);
        expect(await r?.text()).toBe(redirect ? '' : 'Not found');
        if (redirect) expect(r?.headers.get('location')).toBe('/admin/login');
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

describe('Cloudflare historical traffic', () => {
  it('fills historical references, preserves first-party overlap and separates totals', async () => {
    await recordVisitor(env.DB, secret, browser(), now);
    await sql(
      "INSERT INTO cf_daily_traffic(day_utc,uniques,page_views,requests,fetched_at,is_partial) VALUES ('2026-11-10',344,259,1623,?,0),('2026-11-11',153,211,1158,?,1)",
      now,
      now,
    );
    const d = await loadDashboard(env.DB, range());
    const old = d.daily.find((r) => r.day === '2026-11-10')!;
    const overlap = d.daily.find((r) => r.day === '2026-11-11')!;
    expect(old).toMatchObject({ visitors: null, cfVisitors: 344, cfPageViews: 259, cfRequests: 1623 });
    expect(visitorReference(old)).toEqual({ value: 344, source: 'cloudflare', timeZone: 'UTC' });
    expect(overlap).toMatchObject({ visitors: 1, cfVisitors: 153, cfPageViews: 211 });
    expect(visitorReference(overlap)).toEqual({ value: 1, source: 'first_party', timeZone: 'Asia/Shanghai' });
    expect(d.totals).toMatchObject({
      visitors: 1,
      cfVisitors: 497,
      cfPageViews: 470,
      cfRequests: 2781,
      revenue: 0,
    });
    expect(d.cfHistory).toEqual({
      from: '2026-11-10',
      to: '2026-11-11',
      fetchedAt: now,
      partialDays: ['2026-11-11'],
      source: 'httpRequests1dGroups',
    });
    expect(d.daily.find((r) => r.day === '2026-11-09')).toMatchObject({
      visitors: null,
      cfVisitors: null,
      cfPageViews: null,
    });
    const html = renderDashboard(d);
    expect(html).toContain('Cloudflare 统计（含部分机器人，按 UTC 日）');
    expect(html).toContain('11 月 10 日 08:00 至 11 月 11 日 08:00');
    expect(html).toContain('未结束日的截至抓取时快照');
    expect(html).toContain('仅一次性补录，不会自动刷新');
    expect(html).not.toContain('所有日期均为北京时间');
  });
  it('treats real zero counts as available and never substitutes CF for first-party zero', async () => {
    await sql("INSERT INTO analytics_meta(key,value) VALUES ('tracking_started_at',?)", now);
    await sql(
      "INSERT INTO cf_daily_traffic(day_utc,uniques,page_views,requests,fetched_at,is_partial) VALUES ('2026-11-10',0,0,0,?,0),('2026-11-11',200,300,400,?,1)",
      now,
      now,
    );
    const d = await loadDashboard(env.DB, range());
    expect(visitorReference(d.daily.find((r) => r.day === '2026-11-11')!)).toEqual({
      value: 0,
      source: 'first_party',
      timeZone: 'Asia/Shanghai',
    });
    expect(visitorReference(d.daily.find((r) => r.day === '2026-11-10')!)).toEqual({
      value: 0,
      source: 'cloudflare',
      timeZone: 'UTC',
    });
    expect(d.totals.visitors).toBe(0);
    expect(d.totals.cfVisitors).toBe(200);
  });
  it('loads history independently of whether first-party tracking has started', async () => {
    await sql(
      "INSERT INTO cf_daily_traffic(day_utc,uniques,page_views,requests,fetched_at,is_partial) VALUES ('2026-11-10',344,259,1623,?,0)",
      now,
    );
    const d = await loadDashboard(env.DB, range());
    expect(d.trackingStartedAt).toBeNull();
    expect(d.totals.visitors).toBeNull();
    expect(d.totals.cfVisitors).toBe(344);
    expect(d.totals.cfPageViews).toBe(259);
    expect(await env.DB.prepare('SELECT count(*) FROM daily_visitors').first('count(*)')).toBe(0);
    expect((await handleAdminRequest(req('/api/admin/dashboard'), adminEnv, async () => owner))?.status).toBe(
      200,
    );
  });
});

function dimensionRequest(
  path = '/?utm_source=Newsletter',
  referer = 'https://www.google.com/search?q=private',
  ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36',
  ip = '192.0.2.101',
) {
  const request = new Request(`https://faceriff.com${path}`, {
    headers: { 'user-agent': ua, 'cf-connecting-ip': ip, referer },
  });
  Object.defineProperty(request, 'cf', { value: { country: 'US' } });
  return request;
}
describe('privacy-safe first-visit dimensions', () => {
  it('parses country, desktop, OS/browser, source and campaign without retaining raw values', () => {
    expect(visitorDimensions(dimensionRequest())).toEqual({
      country: 'US',
      device: 'desktop',
      os: 'Windows',
      browser: 'Chrome',
      referrer: 'google',
      utm_source: 'newsletter',
      language: 'unknown',
      lang_base: 'unknown',
    });
    expect(visitorDimensions(dimensionRequest('/', 'https://x.com/private/path?secret=a')).referrer).toBe(
      'x',
    );
    expect(visitorDimensions(dimensionRequest('/', 'https://user123.private.example/secret')).referrer).toBe(
      'other',
    );
    expect(visitorDimensions(dimensionRequest('/?utm_source=user%40example.com')).utm_source).toBe(
      '__redacted__',
    );
    expect(visitorDimensions(dimensionRequest('/?utm_source=https%3A%2F%2Fx.com')).utm_source).toBe(
      '__redacted__',
    );
    expect(visitorDimensions(dimensionRequest(`/?utm_source=${'a'.repeat(100)}`)).utm_source).toBe(
      '__redacted__',
    );
    expect(referrerPlatform('notgoogle.com')).toBe('other');
    expect(referrerPlatform('google.com.evil.example')).toBe('other');
    expect(referrerPlatform('www.producthunt.com')).toBe('producthunt');
    expect(visitorDimensions(browser()).referrer).toBe('direct');
    expect(visitorDimensions(browser()).country).toBe('ZZ');
    expect(visitorDimensions(browser()).utm_source).toBe('__none__');
    expect(visitorDimensions(dimensionRequest('/?utm_source=none')).utm_source).toBe('none');
  });
  it('distinguishes phones/tablets and browser families', () => {
    const cases = [
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile/15E148 Safari/604.1',
        'mobile',
        'iOS',
        'Safari',
      ],
      [
        'Mozilla/5.0 (iPad; CPU OS 19_0) AppleWebKit/605.1.15 Version/19.0 Mobile/15E148 Safari/604.1',
        'tablet',
        'iOS',
        'Safari',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        'tablet',
        'iOS',
        'Safari',
      ],
      [
        'Mozilla/5.0 (Linux; Android 16; Pixel) Chrome/140.0 Mobile Safari/537.36',
        'mobile',
        'Android',
        'Chrome',
      ],
      ['Mozilla/5.0 (Linux; Android 16; Tablet) Chrome/140.0 Safari/537.36', 'tablet', 'Android', 'Chrome'],
      ['Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0', 'desktop', 'Windows', 'Edge'],
      ['Mozilla/5.0 (Linux x86_64) Gecko/20100101 Firefox/145.0', 'desktop', 'Linux', 'Firefox'],
    ];
    for (const [ua, device, os, browser] of cases)
      expect(visitorDimensions(dimensionRequest('/', '', ua))).toMatchObject({ device, os, browser });
  });
  it('atomically counts only one first visit even with parallel duplicates and changed source', async () => {
    const r = dimensionRequest();
    await Promise.all(Array.from({ length: 12 }, () => recordVisitor(env.DB, secret, r, now)));
    await recordVisitor(
      env.DB,
      secret,
      dimensionRequest('/?utm_source=reddit', 'https://reddit.com/r/test'),
      now,
    );
    const counts = await env.DB.prepare(
      'SELECT dimension,value,count FROM daily_visitor_dimensions ORDER BY dimension',
    ).all();
    expect(counts.results).toHaveLength(8);
    expect(counts.results.every((r) => r.count === 1)).toBe(true);
    expect(counts.results.find((r) => r.dimension === 'referrer')?.value).toBe('google');
    expect(counts.results.find((r) => r.dimension === 'utm_source')?.value).toBe('newsletter');
    expect(await env.DB.prepare('SELECT count(*) n FROM daily_visitors').first('n')).toBe(1);
    const serialized = JSON.stringify(counts.results);
    for (const raw of ['192.0.2.101', 'Mozilla', '/search', 'q=private', 'visitor_hash'])
      expect(serialized).not.toContain(raw);
  });
  it('keeps old daily UV and new dimension coverage distinct, then counts the next day', async () => {
    const r = dimensionRequest();
    const hash = await visitorHash(secret, shanghaiDay(now), '192.0.2.101', r.headers.get('user-agent')!);
    await sql('INSERT INTO daily_visitors(day,visitor_hash) VALUES (?,?)', shanghaiDay(now), hash);
    await recordVisitor(env.DB, secret, r, now);
    expect(await env.DB.prepare('SELECT count(*) n FROM daily_visitor_dimensions').first('n')).toBe(0);
    await recordVisitor(env.DB, secret, r, now + 86400000);
    expect(await env.DB.prepare('SELECT sum(count) n FROM daily_visitor_dimensions').first('n')).toBe(8);
  });
  it('retains only 90 days of marginal counts', async () => {
    await sql(
      "INSERT INTO daily_visitor_dimensions(day,dimension,value,count) VALUES ('2026-01-01','country','US',50)",
    );
    await recordVisitor(env.DB, secret, dimensionRequest(), now);
    expect(
      await env.DB.prepare("SELECT count(*) n FROM daily_visitor_dimensions WHERE day='2026-01-01'").first(
        'n',
      ),
    ).toBe(0);
  });
  it('separates datasets, applies selected range and renders Chinese labels and coverage', async () => {
    await recordVisitor(env.DB, secret, dimensionRequest(), now);
    await sql(
      "INSERT INTO cf_daily_dimensions(day_utc,dataset,dimension,value,count,fetched_at,is_partial) VALUES ('2026-11-10','httpRequests1dGroups','country','US',300,?,0),('2026-11-11','httpRequestsAdaptiveGroups','device','mobile',200,?,1),('2026-10-29','httpRequestsAdaptiveGroups','device','desktop',900,?,0)",
      now,
      now,
      now,
    );
    const d = await loadDashboard(env.DB, range());
    expect(d.dimensions.firstParty.find((r) => r.dimension === 'country')).toMatchObject({
      value: 'US',
      count: 1,
    });
    expect(
      d.dimensions.cloudflare.filter((r) => r.dimension === 'device').reduce((n, r) => n + r.count, 0),
    ).toBe(200);
    expect(d.dimensions.coverage.find((r) => r.dimension === 'device')).toMatchObject({
      fromDay: '2026-10-29',
      toDay: '2026-11-11',
      days: 2,
      partialDays: '2026-11-11',
    });
    const html = renderDashboard(d);
    for (const text of [
      'US · 美国',
      '手机',
      'Google',
      'newsletter',
      '100.0%',
      '请求数（含机器人）',
      'clientRefererHost',
      '不是 UV',
      '不相加',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('q=private');
    expect((await handleAdminRequest(req('/api/admin/dashboard'), adminEnv, async () => null))?.status).toBe(
      404,
    );
  });
});

describe('manual review queue', () => {
  const origin = 'https://faceriff.com';
  const review = JSON.stringify({
    version: 1,
    composed: true,
    composeError: null,
    rawKey: 'jobs/job_held/0.mp4',
    notes: [
      {
        part: 'full',
        reason: 'grey',
        threshold: 0.55,
        scores: [0.31, 0.61],
        slots: ['lead', 'sax'],
        quality: {
          version: 2,
          verdict: 'review',
          similarity: [0.31, 0.61],
          sampleCount: 36,
          roles: [
            { index: 0, verdict: 'pass', visible: 6, valid: 6, peak: 0.31, strong: 0, strongFraction: 0, longestStrongRun: 0, weak: 0 },
            { index: 1, verdict: 'review', visible: 6, valid: 6, peak: 0.61, strong: 1, strongFraction: 0.17, longestStrongRun: 1, weak: 3 },
          ],
        },
      },
    ],
  });
  async function held() {
    await user();
    await sql(
      "INSERT INTO jobs(id,user_id,model_id,kind,prompt,input_json,status,upstream,upstream_job_id,error_code,outputs_json,review_json,cost_credits,created_at,finished_at) VALUES ('job_held','u','tiny-desk','video','private prompt','{}','needs_review','yir','up_h','review_grey',?,?,10,?,?)",
      JSON.stringify([{ key: 'jobs/job_held/1.mp4', mediaType: 'video/mp4' }]),
      review,
      now,
      now + 60_000,
    );
    await env.OUTPUTS.put('jobs/job_held/1.mp4', '0123456789');
    await env.OUTPUTS.put('jobs/job_held/0.mp4', 'raw-bytes');
  }
  const post = (body: string, headers: Record<string, string> = { origin }) =>
    new Request(`${origin}/admin/review/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body,
    });

  it('non-admins get 404 everywhere (including the POST action); anonymous queue visits go to login', async () => {
    await held();
    for (const u of [null, { ...owner, email: 'customer@example.com' }]) {
      for (const r of [
        req('/admin/review/confirm?job=job_held&action=approve'),
        req('/api/admin/review-video?job=job_held'),
        post('job=job_held&action=approve'),
      ])
        expect((await handleAdminRequest(r, adminEnv, async () => u))?.status).toBe(404);
      const queue = await handleAdminRequest(req('/admin/review'), adminEnv, async () => u);
      expect(queue?.status).toBe(u ? 404 : 302);
    }
    expect((await env.DB.prepare("SELECT status FROM jobs WHERE id='job_held'").first())?.status).toBe('needs_review');
  });

  it('lists pending jobs with full email, Shanghai time, per-role scores, threshold and inline preview; dashboard shows the count', async () => {
    await held();
    const r = await handleAdminRequest(req('/admin/review'), adminEnv, async () => owner);
    expect(r?.status).toBe(200);
    expect(r?.headers.get('content-security-policy')).toContain("media-src 'self'");
    const html = await r!.text();
    expect(html).toContain('danger@example.com');
    expect(html).toContain('2026/11/11 12:00:00');
    expect(html).toContain('Lead vocals');
    expect(html).toContain('0.610');
    expect(html).toContain('阈值 0.55');
    expect(html).toContain('/api/admin/review-video?job=job_held');
    expect(html).not.toContain('private prompt');
    const d = await loadDashboard(env.DB, range());
    expect(d.pendingReviews).toBe(1);
    expect(renderDashboard(d)).toContain('href="/admin/review"');
    const empty = renderReviewPage({ pending: [], history: [] });
    expect(empty).toContain('目前没有待审核任务');
  });

  it('streams the held video inline with Range, raw on request, never unrelated keys', async () => {
    await held();
    const full = await handleAdminRequest(req('/api/admin/review-video?job=job_held'), adminEnv, async () => owner);
    expect(full?.status).toBe(200);
    expect(full?.headers.get('content-disposition')).toContain('inline');
    expect(await full?.text()).toBe('0123456789');
    const part = await handleAdminRequest(
      new Request(`${origin}/api/admin/review-video?job=job_held`, { headers: { range: 'bytes=2-5' } }),
      adminEnv,
      async () => owner,
    );
    expect(part?.status).toBe(206);
    expect(part?.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await part?.text()).toBe('2345');
    const raw = await handleAdminRequest(req('/api/admin/review-video?job=job_held&v=raw'), adminEnv, async () => owner);
    expect(await raw?.text()).toBe('raw-bytes');
    await sql("UPDATE jobs SET outputs_json=? WHERE id='job_held'", JSON.stringify([{ key: 'uploads/up_x.png' }]));
    expect(
      (await handleAdminRequest(req('/api/admin/review-video?job=job_held'), adminEnv, async () => owner))?.status,
    ).toBe(404);
  });

  it('confirm page, then same-origin POST approves once and logs who; cross-site or malformed posts change nothing', async () => {
    await held();
    const confirm = await handleAdminRequest(
      req('/admin/review/confirm?job=job_held&action=approve'),
      adminEnv,
      async () => owner,
    );
    expect(confirm?.status).toBe(200);
    expect(await confirm?.text()).toContain('action="/admin/review/action"');
    for (const bad of [
      post('job=job_held&action=approve', { origin: 'https://evil.example' }),
      post('job=job_held&action=approve', { origin, 'sec-fetch-site': 'cross-site' }),
      post('job=job_held&action=approve', {}),
    ])
      expect((await handleAdminRequest(bad, adminEnv, async () => owner))?.status).toBe(403);
    expect((await handleAdminRequest(post('job=job_held&action=delete'), adminEnv, async () => owner))?.status).toBe(400);
    expect((await handleAdminRequest(req('/admin/review/action'), adminEnv, async () => owner))?.status).toBe(405);
    expect((await env.DB.prepare("SELECT status FROM jobs WHERE id='job_held'").first())?.status).toBe('needs_review');
    const ok = await handleAdminRequest(post('job=job_held&action=approve'), adminEnv, async () => owner);
    expect(ok?.status).toBe(303);
    expect(ok?.headers.get('location')).toBe('/admin/review?done=approved&job=job_held');
    const again = await handleAdminRequest(post('job=job_held&action=approve'), adminEnv, async () => owner);
    expect(again?.headers.get('location')).toBe('/admin/review?done=noop&job=job_held');
    const job = await env.DB.prepare("SELECT status,error_code FROM jobs WHERE id='job_held'").first();
    expect(job).toMatchObject({ status: 'succeeded', error_code: null });
    const log = await env.DB.prepare("SELECT action,admin_email FROM job_reviews WHERE job_id='job_held'").first();
    expect(log).toMatchObject({ action: 'approved', admin_email: owner.email });
    const page = await (await handleAdminRequest(req('/admin/review'), adminEnv, async () => owner))!.text();
    expect(page).toContain('最近 30 天审核记录');
    expect(page).toContain('通过并交付</span>');
    const { pending, history } = await loadReviewQueue(env.DB);
    expect(pending).toHaveLength(0);
    expect(history).toHaveLength(1);
    expect(
      (await handleAdminRequest(req('/admin/review/confirm?job=job_held&action=reject'), adminEnv, async () => owner))
        ?.status,
    ).toBe(409);
  });

  it('a failed customer email keeps the decision and tells the owner to follow up', async () => {
    await held();
    const mailEnv = {
      ...adminEnv,
      EMAIL_FROM: 'noreply@faceriff.com',
      EMAIL: { send: async () => { throw new Error('mail down'); } } as unknown as SendEmail,
    };
    const r = await handleAdminRequest(post('job=job_held&action=approve'), mailEnv, async () => owner);
    expect(r?.headers.get('location')).toBe('/admin/review?done=approved_nomail&job=job_held');
    expect((await env.DB.prepare("SELECT status FROM jobs WHERE id='job_held'").first())?.status).toBe('succeeded');
    const flash = await (await handleAdminRequest(req('/admin/review?done=approved_nomail&job=job_held'), adminEnv, async () => owner))!.text();
    expect(flash).toContain('邮件发送失败');
  });

  it('reject marks failed with a *_reviewed code (not a held account)', async () => {
    await held();
    const r = await handleAdminRequest(post('job=job_held&action=reject'), adminEnv, async () => owner);
    expect(r?.headers.get('location')).toBe('/admin/review?done=rejected&job=job_held');
    const job = await env.DB.prepare("SELECT status,error_code FROM jobs WHERE id='job_held'").first();
    expect(job).toMatchObject({ status: 'failed', error_code: 'review_grey_reviewed' });
    expect((await loadDashboard(env.DB, range())).held).toHaveLength(0);
  });
});
