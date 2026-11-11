import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AdminAuthHandler, handleAdminLogin } from '../src/lib/admin-login.server';

const secret = 'admin-login-test-only-key-never-for-production-12345';
const loginEnv = {
  DB: env.DB,
  ADMIN_EMAILS: ' owner@example.com, SECOND@example.com ',
  BETTER_AUTH_SECRET: secret,
};
const now = Date.parse('2026-11-11T12:00:00+08:00');
function post(
  path = '/admin/login/send',
  values: Record<string, string> = { email: 'owner@example.com' },
  ip = '192.0.2.50',
  origin: string | null = 'https://faceriff.com',
) {
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    'cf-connecting-ip': ip,
    'user-agent': 'Admin login unit test',
  });
  if (origin) headers.set('origin', origin);
  return new Request(`https://faceriff.com${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(values),
  });
}
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM quota_counters WHERE key LIKE 'admin-login:%'").run();
});
describe('dedicated allowlisted admin login', () => {
  it('renders a private noindex login and HEAD without exposing the allowlist', async () => {
    for (const method of ['GET', 'HEAD']) {
      const response = await handleAdminLogin(
        new Request('https://faceriff.com/admin/login', { method }),
        loginEnv,
        async () => {
          throw Error('must not invoke auth');
        },
        now,
      );
      expect(response?.status).toBe(200);
      expect(response?.headers.get('cache-control')).toContain('no-store');
      expect(response?.headers.get('x-robots-tag')).toContain('noindex');
      expect(response?.headers.get('referrer-policy')).toBe('same-origin');
      const body = await response!.text();
      expect(body).not.toContain('owner@example.com');
      expect(body).not.toContain('SECOND@example.com');
      if (method === 'HEAD') expect(body).toBe('');
      else {
        expect(body).toContain('/admin/login/send');
        expect(body).toContain('普通用户登录');
      }
    }
  });
  it('does not intercept public login/auth or other application paths', async () => {
    for (const path of [
      '/login',
      '/',
      '/api/auth/email-otp/send-verification-otp',
      '/api/auth/sign-in/email-otp',
      '/api/admin/dashboard',
      '/admin',
    ]) {
      expect(
        await handleAdminLogin(
          post(path),
          loginEnv,
          async () => {
            throw Error('not reached');
          },
          now,
        ),
      ).toBeNull();
    }
  });
  it('rejects all non-allowlisted emails identically before any auth call', async () => {
    let calls = 0;
    const auth: AdminAuthHandler = async () => {
      calls++;
      return Response.json({ success: true });
    };
    const responses = [];
    for (const email of [
      'customer@example.com',
      'missing@example.com',
      'owner@example.com.evil',
      'invalid',
    ]) {
      const response = await handleAdminLogin(post('/admin/login/send', { email }), loginEnv, auth, now);
      expect(response?.status).toBe(403);
      responses.push(await response!.text());
    }
    expect(new Set(responses).size).toBe(1);
    expect(responses[0]).toContain('无权访问');
    expect(responses[0]).not.toContain('customer@example.com');
    expect(calls).toBe(0);
    const empty = await handleAdminLogin(post(), { ...loginEnv, ADMIN_EMAILS: undefined }, auth, now);
    expect(empty?.status).toBe(403);
    expect(calls).toBe(0);
  });
  it('normalizes an allowlisted email and delegates exactly one sign-in send', async () => {
    const requests: Request[] = [];
    const response = await handleAdminLogin(
      post('/admin/login/send', {
        email: ' OWNER@EXAMPLE.COM ',
        type: 'forget-password',
        callbackURL: 'https://evil.example',
      }),
      loginEnv,
      async (r) => {
        requests.push(r);
        return Response.json({ success: true });
      },
      now,
    );
    expect(response?.status).toBe(200);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(new URL(request.url).pathname).toBe('/api/auth/email-otp/send-verification-otp');
    expect(await request.json()).toEqual({ email: 'owner@example.com', type: 'sign-in' });
    expect(request.headers.get('origin')).toBe('https://faceriff.com');
    expect(request.headers.get('cf-connecting-ip')).toBe('192.0.2.50');
    expect(await response!.text()).toContain('/admin/login/verify');
    expect(response?.headers.get('cache-control')).toContain('no-store');
  });
  it('verifies only allowlisted OTPs and preserves every auth cookie on a fixed redirect', async () => {
    let calls = 0;
    const response = await handleAdminLogin(
      post('/admin/login/verify', {
        email: 'owner@example.com',
        otp: '012345',
        callbackURL: 'https://evil.example',
      }),
      loginEnv,
      async (r) => {
        calls++;
        expect(new URL(r.url).pathname).toBe('/api/auth/sign-in/email-otp');
        expect(await r.json()).toEqual({ email: 'owner@example.com', otp: '012345' });
        const headers = new Headers({ 'content-type': 'application/json' });
        headers.append('set-cookie', 'test_session=fake-unit-test-value; Path=/; HttpOnly; Secure');
        headers.append('set-cookie', 'test_data=fake-unit-test-data; Path=/; HttpOnly; Secure');
        return new Response(JSON.stringify({ token: 'must-not-be-exposed' }), { headers });
      },
      now,
    );
    expect(calls).toBe(1);
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe('/admin');
    expect(response?.headers.getSetCookie()).toHaveLength(2);
    expect(await response!.text()).toBe('');
    const denied = await handleAdminLogin(
      post('/admin/login/verify', { email: 'customer@example.com', otp: '012345' }),
      loginEnv,
      async () => {
        calls++;
        return Response.json({});
      },
      now,
    );
    expect(denied?.status).toBe(403);
    expect(calls).toBe(1);
  });
  it('rejects wrong-format codes without auth or resending, and hides upstream errors', async () => {
    let calls = 0;
    const auth = async () => {
      calls++;
      return Response.json({ message: 'private-account-exists-error' }, { status: 400 });
    };
    expect(
      (
        await handleAdminLogin(
          post('/admin/login/verify', { email: 'owner@example.com', otp: 'bad' }),
          loginEnv,
          auth,
          now,
        )
      )?.status,
    ).toBe(400);
    expect(calls).toBe(0);
    const response = await handleAdminLogin(
      post('/admin/login/verify', { email: 'owner@example.com', otp: '123456' }),
      loginEnv,
      auth,
      now,
    );
    expect(response?.status).toBe(400);
    expect(await response!.text()).not.toContain('private-account-exists-error');
    expect(calls).toBe(1);
  });
  it('enforces same-origin POSTs and rejects GETs without sending', async () => {
    const auth = async () => {
      throw Error('must not invoke');
    };
    for (const origin of [null, 'https://evil.example'])
      expect(
        (
          await handleAdminLogin(
            post('/admin/login/send', { email: 'owner@example.com' }, '192.0.2.50', origin),
            loginEnv,
            auth,
            now,
          )
        )?.status,
      ).toBe(403);
    const cross = post();
    cross.headers.set('sec-fetch-site', 'cross-site');
    expect((await handleAdminLogin(cross, loginEnv, auth, now))?.status).toBe(403);
    expect(
      (await handleAdminLogin(new Request('https://faceriff.com/admin/login/send'), loginEnv, auth, now))
        ?.status,
    ).toBe(405);
    expect(
      await env.DB.prepare("SELECT count(*) n FROM quota_counters WHERE key LIKE 'admin-login:%'").first('n'),
    ).toBe(0);
  });
  it('rate limits IPs atomically and stores hashes, not IPs/email/OTP', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        handleAdminLogin(
          post('/admin/login/send', { email: 'missing@example.com' }),
          loginEnv,
          async () => {
            throw Error('not reached');
          },
          now,
        ),
      ),
    );
    expect(results.filter((r) => r?.status === 403)).toHaveLength(5);
    expect(results.filter((r) => r?.status === 429)).toHaveLength(7);
    const rows = await env.DB.prepare("SELECT * FROM quota_counters WHERE key LIKE 'admin-login:%'").all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.key).toMatch(/^admin-login:send-ip:[a-f0-9]{64}$/);
    for (const raw of ['192.0.2.50', 'missing@example.com', '123456', secret])
      expect(JSON.stringify(rows.results)).not.toContain(raw);
  });
  it('caps sends to one allowed email across different IPs', async () => {
    let sends = 0;
    const auth = async () => {
      sends++;
      return Response.json({ success: true });
    };
    for (let i = 0; i < 4; i++) {
      const response = await handleAdminLogin(
        post('/admin/login/send', { email: 'owner@example.com' }, `192.0.2.${60 + i}`),
        loginEnv,
        auth,
        now,
      );
      expect(response?.status).toBe(i < 3 ? 200 : 429);
    }
    expect(sends).toBe(3);
  });
  it('expires only own counters after two days and fails closed on missing secret/IP', async () => {
    await env.DB.prepare(
      "INSERT INTO quota_counters(key,window,count) VALUES ('admin-login:old','000000000001',1),('unrelated-preserved','000000000001',1)",
    ).run();
    await handleAdminLogin(
      post('/admin/login/send', { email: 'missing@example.com' }),
      loginEnv,
      async () => {
        throw Error('not reached');
      },
      now,
    );
    expect(
      await env.DB.prepare("SELECT count(*) n FROM quota_counters WHERE key='admin-login:old'").first('n'),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT count(*) n FROM quota_counters WHERE key='unrelated-preserved'").first(
        'n',
      ),
    ).toBe(1);
    await env.DB.prepare("DELETE FROM quota_counters WHERE key='unrelated-preserved'").run();
    const auth = async () => {
      throw Error('not reached');
    };
    expect((await handleAdminLogin(post(), { ...loginEnv, BETTER_AUTH_SECRET: '' }, auth, now))?.status).toBe(
      503,
    );
    const noIP = post();
    noIP.headers.delete('cf-connecting-ip');
    expect((await handleAdminLogin(noIP, loginEnv, auth, now))?.status).toBe(503);
  });
  it('bounds and validates form bodies before auth, ignoring non-form and duplicate input', async () => {
    const auth = async () => {
      throw Error('not reached');
    };
    expect(
      (
        await handleAdminLogin(
          post('/admin/login/send', { email: 'owner@example.com', padding: 'a'.repeat(3000) }),
          loginEnv,
          auth,
          now,
        )
      )?.status,
    ).toBe(403);
    const json = new Request('https://faceriff.com/admin/login/send', {
      method: 'POST',
      headers: {
        origin: 'https://faceriff.com',
        'cf-connecting-ip': '192.0.2.51',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'owner@example.com' }),
    });
    expect((await handleAdminLogin(json, loginEnv, auth, now))?.status).toBe(403);
    const duplicate = new Request('https://faceriff.com/admin/login/send', {
      method: 'POST',
      headers: {
        origin: 'https://faceriff.com',
        'cf-connecting-ip': '192.0.2.52',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'email=owner%40example.com&email=missing%40example.com',
    });
    expect((await handleAdminLogin(duplicate, loginEnv, auth, now))?.status).toBe(403);
  });
  it('handles send failures generically with no false code-sent confirmation', async () => {
    const response = await handleAdminLogin(
      post(),
      loginEnv,
      async () => Response.json({ message: 'private-delivery-details' }, { status: 500 }),
      now,
    );
    expect(response?.status).toBe(503);
    const body = await response!.text();
    expect(body).not.toContain('private-delivery-details');
    expect(body).not.toContain('验证码已发送');
  });
});
