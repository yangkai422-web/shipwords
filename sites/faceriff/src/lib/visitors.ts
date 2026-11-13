import { DAY, shanghaiDay } from './admin-data';
import { realtimeStatements } from './realtime';
import { visitorDimensions } from './visitor-dimensions';

export function isVisitorRequest(request: Request, response: Response): boolean {
  const path = new URL(request.url).pathname;
  const ua = request.headers.get('user-agent') ?? '';
  const cf = request.cf as { botManagement?: { verifiedBot?: boolean; score?: number } } | undefined;
  return (
    request.method === 'GET' &&
    response.status === 200 &&
    (response.headers.get('content-type') ?? '').includes('text/html') &&
    // /admin, /admin/*, /api, /api/admin and other non-document paths never count toward UV, pageviews, or realtime online users.
    !/^\/(api|admin|stats|files|assets|__)(\/|$)/.test(path) &&
    !/\.[a-z0-9]{1,8}$/i.test(path) &&
    !!request.headers.get('cf-connecting-ip') &&
    !!ua &&
    !/bot|crawler|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl|wget|python|monitor|uptime/i.test(
      ua,
    ) &&
    !cf?.botManagement?.verifiedBot &&
    !(typeof cf?.botManagement?.score === 'number' && cf.botManagement.score < 30) &&
    !request.headers.get('purpose')?.includes('prefetch') &&
    !request.headers.get('sec-purpose')?.includes('prefetch')
  );
}

export async function visitorHash(secret: string, day: string, ip: string, ua: string): Promise<string> {
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    bytes.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    bytes.encode(JSON.stringify(['faceriff-daily-visitors-v1', day, ip, ua])),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function recordVisitor(
  db: D1Database,
  secret: string,
  request: Request,
  now = Date.now(),
): Promise<void> {
  if (secret.length < 32) return; // Fail closed: no unhashed or weakly keyed identifiers.
  const day = shanghaiDay(now);
  const hash = await visitorHash(
    secret,
    day,
    request.headers.get('cf-connecting-ip') ?? '',
    request.headers.get('user-agent') ?? '',
  );
  const dims = visitorDimensions(request);
  const dimensions = Object.entries(dims);
  // D1 batch is a serial, atomic transaction. Increment before inserting the dedup marker:
  // duplicate/concurrent requests cannot increment a second time, and failures roll back both.
  await db.batch([
    db
      .prepare('INSERT INTO analytics_meta(key,value) VALUES (?,?) ON CONFLICT DO NOTHING')
      .bind('tracking_started_at', now),
    db
      .prepare('INSERT INTO analytics_meta(key,value) VALUES (?,?) ON CONFLICT DO NOTHING')
      .bind('dimensions_started_at', now),
    db
      .prepare(`INSERT INTO daily_visitor_dimensions(day,dimension,value,count)
      SELECT ?,json_extract(d.value,'$[0]'),json_extract(d.value,'$[1]'),1 FROM json_each(?) d
      WHERE NOT EXISTS (SELECT 1 FROM daily_visitors WHERE day=? AND visitor_hash=?)
      ON CONFLICT(day,dimension,value) DO UPDATE SET count=daily_visitor_dimensions.count+1`)
      .bind(day, JSON.stringify(dimensions), day, hash),
    db
      .prepare('INSERT INTO daily_visitors(day,visitor_hash) VALUES (?,?) ON CONFLICT DO NOTHING')
      .bind(day, hash),
    db.prepare('DELETE FROM daily_visitors WHERE day<?').bind(shanghaiDay(now - 90 * DAY)),
    db.prepare('DELETE FROM daily_visitor_dimensions WHERE day<?').bind(shanghaiDay(now - 90 * DAY)),
    // Realtime: every qualifying page view (not only the first of the day), same hashed identity.
    ...realtimeStatements(db, hash, new URL(request.url).pathname, dims, now),
  ]);
}
