import { escapeHtml, secureHeaders } from './admin.server';
import { isAllowlistedEmail } from './admin-access';
export interface AdminLoginEnv {
  DB: D1Database;
  ADMIN_EMAILS?: string;
  BETTER_AUTH_SECRET: string;
}
export type AdminAuthHandler = (request: Request) => Promise<Response>;
const WINDOW = 15 * 60 * 1000;
const MAX_BODY = 2048;
function loginPage(message = '', email: string | null = null, status = 200, head = false): Response {
  const field =
    email == null
      ? '<label>授权邮箱<input name="email" type="email" autocomplete="email" maxlength="254" required></label>'
      : `<p>验证码已发送至 ${escapeHtml(email)}。10 分钟内有效。</p><input name="email" type="hidden" value="${escapeHtml(email)}"><label>六位验证码<input name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required autofocus></label>`;
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>FaceRiff · 后台登录</title><style>body{margin:0;background:#0b1020;color:#eef0ff;font:16px/1.6 system-ui,sans-serif}main{max-width:440px;margin:8vh auto;padding:28px;background:#151b33;border-radius:16px}h1{font-size:26px}p{color:#b8bfd9}label{display:block}input,button{box-sizing:border-box;width:100%;margin:8px 0 20px;padding:12px;border-radius:8px;border:1px solid #eef0ff44;background:#0b1020;color:#fff;font:inherit}button{background:#ff4d6d;cursor:pointer}a{color:#ff839a}.error{color:#ffb5c3}small{color:#b8bfd9}@media(max-width:500px){main{margin:32px 12px;padding:22px}}</style></head><body><main><h1>站主后台登录</h1><p>仅授权邮箱可获取后台登录验证码。普通用户登录不受影响。</p>${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ''}<form method="post" action="/admin/login/${email == null ? 'send' : 'verify'}">${field}<button type="submit">${email == null ? '发送验证码' : '验证并进入后台'}</button></form>${email != null ? '<p><a href="/admin/login">更换邮箱 / 重新获取验证码</a></p>' : ''}<small><a href="/login">普通用户登录</a> · <a href="/">返回网站</a></small></main></body></html>`;
  return new Response(head ? null : body, {
    status,
    // no-referrer can suppress Origin on browser form POSTs; retain same-origin CSRF context.
    headers: {
      ...secureHeaders,
      'referrer-policy': 'same-origin',
      'content-type': 'text/html; charset=utf-8',
    },
  });
}
async function formBody(request: Request): Promise<URLSearchParams> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded')
    throw Error('invalid_form');
  const reader = request.body?.getReader();
  if (!reader) throw Error('empty_form');
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) {
        await reader.cancel();
        throw Error('large_form');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  if (form.getAll('email').length !== 1 || form.getAll('otp').length > 1) throw Error('ambiguous_form');
  return form;
}
async function quota(
  db: D1Database,
  secret: string,
  kind: string,
  identifier: string,
  max: number,
  now: number,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(
      JSON.stringify(['faceriff-admin-login-rate-v1', Math.floor(now / 86400000), kind, identifier]),
    ),
  );
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const window = (n: number) =>
    Math.floor(n / WINDOW)
      .toString()
      .padStart(12, '0');
  const result = await db.batch<{ count: number }>([
    db
      .prepare(
        'INSERT INTO quota_counters(key,window,count) VALUES (?,?,1) ON CONFLICT(key,window) DO UPDATE SET count=quota_counters.count+1 RETURNING count',
      )
      .bind(`admin-login:${kind}:${hash}`, window(now)),
    db
      .prepare("DELETE FROM quota_counters WHERE key LIKE 'admin-login:%' AND window<?")
      .bind(window(now - 2 * 86400000)),
  ]);
  const count = result[0]?.results[0]?.count;
  return typeof count === 'number' && count <= max;
}
export async function handleAdminLogin(
  request: Request,
  env: AdminLoginEnv,
  authHandler: AdminAuthHandler,
  now = Date.now(),
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!['/admin/login', '/admin/login/', '/admin/login/send', '/admin/login/verify'].includes(path))
    return null;
  if (path === '/admin/login' || path === '/admin/login/') {
    if (request.method === 'GET' || request.method === 'HEAD')
      return loginPage('', null, 200, request.method === 'HEAD');
    return new Response(null, { status: 405, headers: { ...secureHeaders, allow: 'GET, HEAD' } });
  }
  if (request.method !== 'POST')
    return new Response(null, { status: 405, headers: { ...secureHeaders, allow: 'POST' } });
  // Browser POSTs must be same-origin. Do not trust Referer or client callback URLs.
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site')
    return loginPage('无权访问', null, 403);
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip || typeof env.BETTER_AUTH_SECRET !== 'string' || env.BETTER_AUTH_SECRET.length < 32)
    return loginPage('登录暂时不可用，请稍后重试。', null, 503);
  const sending = path.endsWith('/send');
  try {
    if (
      !(await quota(
        env.DB,
        env.BETTER_AUTH_SECRET,
        sending ? 'send-ip' : 'verify-ip',
        ip,
        sending ? 5 : 10,
        now,
      ))
    )
      return loginPage('请求过于频繁，请稍后重试。', null, 429);
    let form: URLSearchParams;
    try {
      form = await formBody(request);
    } catch {
      return loginPage('无权访问', null, 403);
    }
    const email = (form.get('email') ?? '').trim().toLowerCase();
    // This branch runs before any better-auth call or customer-account lookup.
    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !isAllowlistedEmail(email, env.ADMIN_EMAILS)
    )
      return loginPage('无权访问', null, 403);
    if (sending && !(await quota(env.DB, env.BETTER_AUTH_SECRET, 'send-email', email, 3, now)))
      return loginPage('请求过于频繁，请稍后重试。', null, 429);
    const otp = form.get('otp') ?? '';
    if (!sending && !/^[0-9]{6}$/.test(otp)) return loginPage('验证码无效或已过期，请重新获取。', email, 400);
    const headers = new Headers({ 'content-type': 'application/json' });
    for (const name of ['origin', 'cookie', 'user-agent', 'cf-connecting-ip']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const authRequest = new Request(
      new URL(
        sending ? '/api/auth/email-otp/send-verification-otp' : '/api/auth/sign-in/email-otp',
        url.origin,
      ),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(sending ? { email, type: 'sign-in' } : { email, otp }),
      },
    );
    const result = await authHandler(authRequest);
    if (!result.ok) {
      if (result.status === 429) return loginPage('请求过于频繁，请稍后重试。', sending ? null : email, 429);
      return loginPage(
        sending ? '暂时无法发送，请稍后重试。' : '验证码无效或已过期，请重新获取。',
        sending ? null : email,
        sending ? 503 : 400,
      );
    }
    if (sending) return loginPage('', email);
    const redirectHeaders = new Headers({ ...secureHeaders, location: '/admin' });
    // Preserve every better-auth session cookie; never expose its JSON token response.
    for (const cookie of result.headers.getSetCookie()) redirectHeaders.append('set-cookie', cookie);
    return new Response(null, { status: 303, headers: redirectHeaders });
  } catch {
    // No email, OTP, IP, cookie, form body or auth response is logged.
    return loginPage('登录暂时不可用，请稍后重试。', null, 503);
  }
}
