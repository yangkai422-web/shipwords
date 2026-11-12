import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { dimensionLabel, handleAdminRequest } from '../src/lib/admin.server';
import { barChart, lineChart, realtimeJson } from '../src/lib/admin-charts';
import { HOUR, loadCharts, loadRealtime, MINUTE, pageKey } from '../src/lib/realtime';
import { isVisitorRequest, recordVisitor, visitorHash } from '../src/lib/visitors';

const secret = 'test-only-key-not-a-production-secret-1234';
const owner = { email: 'owner@example.com', emailVerified: true };
const adminEnv = { DB: env.DB, OUTPUTS: env.OUTPUTS, ADMIN_EMAILS: owner.email };
const now = Date.parse('2026-11-11T12:00:30+08:00');
const req = (path: string, method = 'GET') => new Request(`https://faceriff.com${path}`, { method });
const browser = (path = '/', ua = 'Mozilla/5.0 (iPhone) Mobile Safari/605.1', ip = '192.0.2.3') =>
  new Request(`https://faceriff.com${path}`, {
    headers: { 'user-agent': ua, 'cf-connecting-ip': ip },
    cf: { country: 'US' } as never,
  });
const sql = (s: string, ...p: (string | number | null)[]) =>
  env.DB.prepare(s)
    .bind(...p)
    .run();
async function hit(at: number, visitor: string, path = '/', country = 'US', device = 'mobile', hits = 1) {
  await sql(
    "INSERT INTO visitor_hits(minute,visitor,path,country,device,os,browser,referrer,hits) VALUES (?,?,?,?,?,'iOS','Safari','direct',?)",
    Math.floor(at / MINUTE),
    visitor,
    path,
    country,
    device,
    hits,
  );
}

beforeEach(async () => {
  for (const t of [
    'visitor_hits',
    'daily_pageviews',
    'daily_visitor_dimensions',
    'daily_visitors',
    'cf_daily_traffic',
    'analytics_meta',
    'orders',
    'jobs',
    'user',
  ])
    await sql(`DELETE FROM ${t}`);
});

describe('realtime collection', () => {
  it('keeps only allowlisted page names; token pages and unknown paths never stored raw', () => {
    expect(pageKey('/')).toBe('/');
    expect(pageKey('/Pricing/')).toBe('/pricing');
    expect(pageKey('/phone/abc123secrettoken')).toBe('/phone/*');
    expect(pageKey('/someone@example.com')).toBe('other');
    expect(pageKey('/pricing/extra')).toBe('other');
  });
  it('admin, API and bot traffic is never counted', () => {
    const ok = new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    expect(isVisitorRequest(browser('/'), ok)).toBe(true);
    expect(isVisitorRequest(browser('/admin'), ok)).toBe(false);
    expect(isVisitorRequest(browser('/api/admin/realtime'), ok)).toBe(false);
    expect(isVisitorRequest(browser('/', 'Googlebot/2.1'), ok)).toBe(false);
  });
  it('aggregates repeat views per minute, counts page views, stores no raw IP/UA and prunes after 48h', async () => {
    await recordVisitor(env.DB, secret, browser('/pricing?utm_source=x'), now);
    await recordVisitor(env.DB, secret, browser('/pricing'), now + 1000);
    await recordVisitor(env.DB, secret, browser('/phone/tok_secret'), now + 2000);
    const rows = (await env.DB.prepare('SELECT * FROM visitor_hits ORDER BY path').all()).results;
    const hash = await visitorHash(
      secret,
      '2026-11-11',
      '192.0.2.3',
      'Mozilla/5.0 (iPhone) Mobile Safari/605.1',
    );
    expect(rows).toEqual([
      expect.objectContaining({ path: '/phone/*', hits: 1, visitor: hash.slice(0, 16) }),
      expect.objectContaining({
        path: '/pricing',
        hits: 2,
        country: 'US',
        device: 'mobile',
        os: 'iOS',
        browser: 'Safari',
      }),
    ]);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('192.0.2.3');
    expect(dump).not.toContain('Mozilla');
    expect(dump).not.toContain('tok_secret');
    expect(await env.DB.prepare('SELECT views FROM daily_pageviews').first('views')).toBe(3);
    // Daily UV still counts the visitor once.
    expect(await env.DB.prepare('SELECT count(*) n FROM daily_visitors').first('n')).toBe(1);
    await recordVisitor(env.DB, secret, browser('/'), now + 49 * HOUR);
    expect(await env.DB.prepare('SELECT count(*) n FROM visitor_hits').first('n')).toBe(1);
    expect(
      await env.DB.prepare("SELECT value FROM analytics_meta WHERE key='realtime_started_at'").first('value'),
    ).toBe(now);
  });
});

describe('realtime summary', () => {
  it('counts distinct visitors in 5 and 30 minutes, views per minute, active pages, countries and devices', async () => {
    await hit(now, 'a', '/', 'US', 'mobile', 3);
    await hit(now, 'a', '/pricing');
    await hit(now - 2 * MINUTE, 'b', '/', 'CN', 'desktop', 2);
    await hit(now - 20 * MINUTE, 'c', '/pricing', 'CN', 'desktop');
    await hit(now - 31 * MINUTE, 'old', '/', 'JP', 'tablet', 9);
    const r = await loadRealtime(env.DB, now);
    expect(r).toMatchObject({ online5: 2, online30: 3, views5: 6, views30: 7, perMinute: 1.2 });
    expect(r.series).toHaveLength(30);
    expect(r.series[29]).toBe(4);
    expect(r.series[27]).toBe(2);
    expect(r.pages).toEqual([
      { path: '/', visitors: 2, views: 5, active5: 2 },
      { path: '/pricing', visitors: 2, views: 2, active5: 1 },
    ]);
    expect(r.countries).toEqual([
      { value: 'CN', visitors: 2 },
      { value: 'US', visitors: 1 },
    ]);
    const json = realtimeJson(r, dimensionLabel);
    expect(json.devices.map((d) => d.label)).toEqual(['电脑', '手机']);
    expect(json.pages[0]?.label).toBe('首页 /');
    expect(json.updated).toContain('12:00:30');
  });
});

describe('admin realtime endpoint and charts page', () => {
  it('is 404 for anonymous and non-admin users (no redirect, no data)', async () => {
    for (const u of [null, { ...owner, email: 'customer@example.com' }, { ...owner, emailVerified: false }]) {
      const r = await handleAdminRequest(req('/api/admin/realtime'), adminEnv, async () => u);
      expect(r?.status).toBe(404);
      expect(await r?.text()).toBe('Not found');
      expect(r?.headers.get('cache-control')).toContain('no-store');
    }
  });
  it('returns uncached JSON for the owner', async () => {
    await hit(Date.now(), 'a', '/pricing', 'US', 'mobile');
    const r = await handleAdminRequest(req('/api/admin/realtime'), adminEnv, async () => owner);
    expect(r?.status).toBe(200);
    expect(r?.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(r?.headers.get('content-type')).toContain('application/json');
    const body = (await r?.json()) as { online5: number; pages: { label: string }[] };
    expect(body.online5).toBe(1);
    expect(body.pages[0]?.label).toBe('/pricing');
    expect(JSON.stringify(body)).not.toMatch(/"visitor"|[0-9a-f]{16}/);
    expect(
      (await handleAdminRequest(req('/api/admin/realtime', 'POST'), adminEnv, async () => owner))?.status,
    ).toBe(405);
  });
  it('dashboard renders realtime, charts and a nonce-only script policy', async () => {
    await hit(Date.now(), 'a', '/', 'US', 'mobile');
    const r = await handleAdminRequest(req('/admin'), adminEnv, async () => owner);
    const page = (await r?.text()) ?? '';
    const csp = r?.headers.get('content-security-policy') ?? '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(page).toContain(`<script nonce="${nonce}">`);
    expect(page.match(/<script/g)?.length).toBe(page.split(`<script nonce="${nonce}">`).length - 1);
    expect(page).toContain('/api/admin/realtime');
    for (const s of [
      '实时访客',
      '最后更新',
      '最近 48 小时',
      '最近 30 天',
      'Cloudflare UV · UTC',
      '待审核',
      '设备',
      '来源平台',
    ])
      expect(page).toContain(s);
    expect(page).toContain('id="rt-online5">1<');
    // A second load gets a fresh nonce.
    const again = await handleAdminRequest(req('/admin'), adminEnv, async () => owner);
    expect(again?.headers.get('content-security-policy')).not.toBe(csp);
  });
});

describe('chart data', () => {
  it('leaves hours before collection empty, buckets by hour and combines labelled sources per Shanghai day', async () => {
    await sql("INSERT INTO analytics_meta(key,value) VALUES ('realtime_started_at',?)", now - 3 * HOUR);
    await sql("INSERT INTO analytics_meta(key,value) VALUES ('tracking_started_at',?)", now - 2 * 86_400_000);
    await hit(now - 2 * HOUR, 'a');
    await hit(now - 2 * HOUR + MINUTE, 'a', '/pricing');
    await hit(now - 2 * HOUR + 2 * MINUTE, 'b');
    await sql("INSERT INTO daily_visitors(day,visitor_hash) VALUES ('2026-11-11','h1'),('2026-11-11','h2')");
    await sql("INSERT INTO daily_pageviews(day,views) VALUES ('2026-11-11',7)");
    await sql(
      "INSERT INTO cf_daily_traffic(day_utc,uniques,page_views,requests,fetched_at,is_partial) VALUES ('2026-11-01',40,90,900,1,0)",
    );
    await sql(
      "INSERT INTO user(id,name,email,email_verified,created_at) VALUES ('u','C','c@example.com',1,?)",
      now,
    );
    for (const [id, status] of [
      ['j1', 'succeeded'],
      ['j2', 'failed'],
      ['j3', 'needs_review'],
    ])
      await sql(
        "INSERT INTO jobs(id,user_id,model_id,kind,prompt,input_json,status,upstream,created_at) VALUES (?,'u','tiny-desk','video','p','{}',?,'yir',?)",
        id,
        status,
        now - HOUR,
      );
    await sql(
      "INSERT INTO orders(id,user_id,product_id,provider,status,amount,currency,created_at,paid_at) VALUES ('o1','u','p','paypal','paid',500,'USD',?,?)",
      now,
      now,
    );
    const c = await loadCharts(env.DB, now);
    expect(c.hourly).toHaveLength(48);
    expect(c.hourly[47]?.hour).toBe(Math.floor(now / HOUR));
    expect(c.hourly[43]).toMatchObject({ visitors: null, views: null });
    expect(c.hourly[44]).toMatchObject({ visitors: 0, views: 0 });
    expect(c.hourly[45]).toMatchObject({ visitors: 2, views: 3 });
    expect(c.daily).toHaveLength(30);
    expect(c.daily.at(-1)).toMatchObject({
      day: '2026-11-11',
      visitors: 2,
      views: 7,
      orders: 1,
      paidOrders: 1,
      succeeded: 1,
      failed: 1,
      review: 1,
    });
    expect(c.daily.find((d) => d.day === '2026-11-01')).toMatchObject({
      visitors: null,
      views: null,
      cfVisitors: 40,
      cfViews: 90,
    });
  });
  it('draws gaps for missing values and escapes labels', () => {
    const line = lineChart('t', ['a', 'b', 'c'], [{ name: '<x>', color: '#fff', values: [1, null, 3] }], 1);
    expect(line.match(/M/g)).toHaveLength(2);
    expect(line).not.toContain('<x>');
    const bars = barChart(
      't',
      ['d1'],
      [[{ name: 's', color: '#000', values: [2] }], [{ name: 'f', color: '#111', values: [0] }]],
      1,
    );
    expect(bars.match(/<rect/g)).toHaveLength(1);
  });
});
