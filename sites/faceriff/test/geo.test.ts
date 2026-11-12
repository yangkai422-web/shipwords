import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleAdminRequest } from '../src/lib/admin.server';
import { languageLabel, loadGeo, renderGeo } from '../src/lib/admin-geo';
import { browserLanguage, marketOf, safely, stampCheckout, stampPaid, stampSignup } from '../src/lib/geo';
import { visitorDimensions } from '../src/lib/visitor-dimensions';

const owner = { email: 'owner@example.com', emailVerified: true };
const now = Date.parse('2026-11-12T16:00:00+08:00');
const sql = (s: string, ...p: (string | number | null)[]) =>
  env.DB.prepare(s)
    .bind(...p)
    .run();
const from = (country: string, lang = 'en-US,en;q=0.9', path = '/api/x') =>
  new Request(`https://faceriff.com${path}`, {
    method: 'POST',
    headers: { 'accept-language': lang, 'cf-connecting-ip': '198.51.100.7', 'user-agent': 'Mozilla/5.0' },
    cf: { country } as never,
  });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
async function user(id: string, at: number, country: string | null = null, lang: string | null = null) {
  await sql(
    "INSERT INTO user(id,name,email,email_verified,created_at) VALUES (?,'N',?,1,?)",
    id,
    `${id}@example.com`,
    at,
  );
  await sql(
    'INSERT INTO user_attribution(user_id,signup_country,signup_language,created_at) VALUES (?,?,?,?)',
    id,
    country,
    lang,
    at,
  );
}
async function order(
  id: string,
  at: number,
  paidAt: number | null,
  country: string | null,
  lang: string | null,
) {
  await sql(
    "INSERT INTO orders(id,user_id,product_id,provider,amount,currency,status,created_at,paid_at,country,language) VALUES (?,'u1','video_1','paypal',988,'USD',?,?,?,?,?)",
    id,
    paidAt ? 'paid' : 'pending',
    at,
    paidAt,
    country,
    lang,
  );
}

beforeEach(async () => {
  for (const t of ['daily_visitor_dimensions', 'payments', 'orders', 'user_attribution', 'user'])
    await sql(`DELETE FROM ${t}`);
});

describe('browser language', () => {
  it('keeps the highest-weighted entry as a short whitelisted tag plus base language', () => {
    const cases: [string | null, string, string][] = [
      ['en-US,en;q=0.9', 'en-US', 'en'],
      ['pt-br', 'pt-BR', 'pt'],
      ['de;q=0.5, fr-CA;q=0.9', 'fr-CA', 'fr'],
      ['zh-Hans-CN,zh;q=0.9', 'zh-CN', 'zh'],
      ['zh-Hant', 'zh-TW', 'zh'],
      ['es-419', 'es-419', 'es'],
      ['ja', 'ja', 'ja'],
      ['no', 'nb', 'nb'],
      ['en-us-x-private', 'en-US', 'en'],
      ['xx-YY', 'other', 'other'],
      ['<script>alert(1)</script>', 'other', 'other'],
      ['*', 'other', 'other'],
      ['', 'unknown', 'unknown'],
      [null, 'unknown', 'unknown'],
      [`${'a'.repeat(300)},en`, 'other', 'other'],
    ];
    for (const [header, language, base] of cases) expect(browserLanguage(header)).toEqual({ language, base });
  });
  it('is a visitor dimension next to country and device', () => {
    const d = visitorDimensions(from('US', 'en-GB,en;q=0.8', '/'));
    expect(d).toMatchObject({ country: 'US', language: 'en-GB', lang_base: 'en' });
  });
  it('groups markets for the Europe + North America summary', () => {
    expect(['US', 'CA', 'DE', 'GB', 'CH', 'BR', 'CN', 'ZZ', null].map(marketOf)).toEqual([
      'us',
      'ca',
      'europe',
      'europe',
      'europe',
      'other',
      'other',
      'unknown',
      'unknown',
    ]);
  });
});

describe('signup, order and payment stamps', () => {
  it('stamps a new order once at checkout and the paid location only when the buyer sees it paid', async () => {
    await order('o1', now, null, null, null);
    await stampCheckout(env.DB, from('DE', 'de-DE'), json({ url: 'https://pay', orderId: 'o1' }));
    await stampCheckout(env.DB, from('US'), json({ url: 'https://pay', orderId: 'o1' }));
    await stampCheckout(env.DB, from('US'), json({ error: 'x' }, 400));
    await stampPaid(env.DB, from('FR', 'fr'), json({ orderId: 'o1', status: 'pending' }));
    expect(
      await env.DB.prepare("SELECT country,language,paid_country FROM orders WHERE id='o1'").first(),
    ).toEqual({
      country: 'DE',
      language: 'de-DE',
      paid_country: null,
    });
    await stampPaid(env.DB, from('FR', 'fr'), json({ orderId: 'o1', status: 'paid' }));
    await stampPaid(env.DB, from('US'), json({ orderId: 'o1', status: 'paid' }));
    expect(
      await env.DB.prepare("SELECT paid_country,paid_language FROM orders WHERE id='o1'").first(),
    ).toEqual({
      paid_country: 'FR',
      paid_language: 'fr',
    });
    const row = JSON.stringify(await env.DB.prepare("SELECT * FROM orders WHERE id='o1'").first());
    expect(row).not.toContain('198.51.100.7');
    expect(row).not.toContain('q=0.9');
  });
  it('stamps signup only for an account created in the last 15 minutes, using the session the response set', async () => {
    await user('new', now - 60_000);
    await user('old', now - 86_400_000);
    const seen: string[] = [];
    const lookup = (id: string) => async (h: Headers) => {
      seen.push(h.get('cookie') ?? '');
      return id;
    };
    const signedIn = json({ ok: true }, 200, {
      'set-cookie': '__Secure-faceriff.session_token=tok.sig; Path=/; HttpOnly; Secure',
    });
    await stampSignup(env.DB, from('US', 'en-US'), signedIn, lookup('new'), now);
    await stampSignup(env.DB, from('GB', 'en-GB'), signedIn.clone(), lookup('new'), now);
    await stampSignup(env.DB, from('US'), signedIn.clone(), lookup('old'), now);
    expect(seen[0]).toBe('__Secure-faceriff.session_token=tok.sig');
    expect(
      (
        await env.DB.prepare(
          'SELECT user_id,signup_country,signup_language FROM user_attribution ORDER BY user_id',
        ).all()
      ).results,
    ).toEqual([
      { user_id: 'new', signup_country: 'US', signup_language: 'en-US' },
      { user_id: 'old', signup_country: null, signup_language: null },
    ]);
    // No session cookie (or a sign-out clearing it) → no lookup at all.
    const before = seen.length;
    await stampSignup(env.DB, from('US'), json({}), lookup('new'), now);
    await stampSignup(
      env.DB,
      from('US'),
      json({}, 200, { 'set-cookie': 'faceriff.session_token=; Max-Age=0; Path=/' }),
      lookup('new'),
      now,
    );
    expect(seen.length).toBe(before);
  });
  it('analytics failures never break the response path', async () => {
    await expect(
      safely(async () => {
        throw new Error('db down');
      }, 'test_event'),
    ).resolves.toBeUndefined();
  });
});

describe('localization dashboard', () => {
  it('builds conversion by country, language and market', async () => {
    await sql(
      `INSERT INTO daily_visitor_dimensions(day,dimension,value,count) VALUES
      ('2026-11-12','country','US',10),('2026-11-12','country','DE',5),('2026-11-12','country','CN',3),
      ('2026-11-12','lang_base','en',12),('2026-11-12','lang_base','de',3),('2026-11-12','lang_base','zh',3),
      ('2026-11-12','language','en-US',10),('2026-11-12','language','en-GB',2),('2026-11-12','language','de-DE',3),('2026-11-12','language','zh-CN',3),
      ('2026-09-01','country','US',999)`,
    );
    await user('u1', now - 3_600_000, 'US', 'en-US');
    await user('u2', now - 3_600_000, 'DE', 'de-DE');
    await user('u3', now - 3_600_000);
    await order('o1', now - 1_000_000, now - 900_000, 'US', 'en-US');
    await order('o2', now - 1_000_000, null, 'US', 'en-US');
    await order('o3', now - 1_000_000, null, null, null);
    const g = await loadGeo(env.DB, now);
    expect(g.languageSince).toBe('2026-11-12');
    expect(g.byCountry.find((r) => r.key === 'US')).toEqual({
      key: 'US',
      visitors: 10,
      signups: 1,
      orders: 2,
      paid: 1,
      revenue: 9.88,
    });
    expect(g.byCountry.find((r) => r.key === '__unrecorded__')).toMatchObject({ signups: 1, orders: 1 });
    expect(g.byLanguage.find((r) => r.key === 'en')).toMatchObject({ visitors: 12, signups: 1, paid: 1 });
    expect(g.byLanguage.find((r) => r.key === 'de')).toMatchObject({ visitors: 3, signups: 1, paid: 0 });
    expect(g.markets.map((m) => [m.key, m.visitors])).toEqual([
      ['us', 10],
      ['ca', 0],
      ['europe', 5],
      ['other', 3],
      ['unknown', 0],
      ['__unrecorded__', 0],
    ]);
    const html = renderGeo(g, (c) => c);
    for (const s of [
      '欧洲 + 北美',
      '83.3%',
      '按国家 / 地区转化',
      '按浏览器基础语言转化',
      '10.0%',
      '$9.88',
      '未记录',
    ])
      expect(html).toContain(s);
    expect(languageLabel('en-US')).toContain('en-US');
  });
  it('appears on the owner dashboard', async () => {
    const r = await handleAdminRequest(
      new Request('https://faceriff.com/admin'),
      { DB: env.DB, OUTPUTS: env.OUTPUTS, ADMIN_EMAILS: owner.email },
      async () => owner,
    );
    const page = (await r?.text()) ?? '';
    expect(page).toContain('本地化决策');
    expect(page).toContain('浏览器语言');
  });
});
