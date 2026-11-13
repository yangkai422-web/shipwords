import { shanghaiDay } from './admin-data';
import { CONVERSION_EVENTS, type ConversionEventName, isConversionEvent } from './conversion-event-names';

export { CONVERSION_EVENTS, isConversionEvent, type ConversionEventName };

const MAX_BODY = 2048;
const MAX_PROPS = 8;
const MAX_KEY = 40;
const MAX_VALUE = 120;
const KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/;

export type EventProps = Record<string, string | number | boolean>;

export function sanitizeProps(input: unknown): EventProps {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: EventProps = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PROPS) break;
    if (key.length > MAX_KEY || !KEY.test(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      out[key] = value;
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, MAX_VALUE);
    }
  }
  return out;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `evt_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function recordConversionEvent(
  db: D1Database,
  event: {
    name: string;
    props?: EventProps;
    dedupeKey?: string;
    now?: number;
  },
): Promise<boolean> {
  if (!isConversionEvent(event.name)) return false;
  const now = event.now ?? Date.now();
  const props = sanitizeProps(event.props ?? {});
  const dedupe =
    typeof event.dedupeKey === 'string' && event.dedupeKey.length > 0 && event.dedupeKey.length <= 120
      ? event.dedupeKey
      : null;
  try {
    const result = await db
      .prepare(
        'INSERT OR IGNORE INTO conversion_events(id,name,props,dedupe_key,created_at,day) VALUES (?,?,?,?,?,?)',
      )
      .bind(newId(), event.name, JSON.stringify(props), dedupe, now, shanghaiDay(now))
      .run();
    return (result.meta.changes ?? 0) > 0;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'conversion_event_failed',
        name: event.name,
        message: error instanceof Error ? error.message : 'unknown',
      }),
    );
    return false;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** Public POST /api/track. Returns null for every other path. Never throws. */
export async function handleTrackRequest(
  request: Request,
  env: { DB: D1Database },
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== '/api/track') return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: 'POST, OPTIONS' } });
  if (request.method !== 'POST')
    return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS' } });
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'too_large' }, 413);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const name = typeof body.name === 'string' ? body.name : '';
    if (!isConversionEvent(name)) return json({ error: 'unknown_event' }, 400);
    const dedupeKey = typeof body.dedupe_key === 'string' ? body.dedupe_key : undefined;
    await recordConversionEvent(env.DB, { name, props: sanitizeProps(body.props), dedupeKey });
    return json(null, 204);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
}

export interface ConversionSnapshot {
  day: string;
  counts: { name: string; n: number }[];
  recent: { name: string; props: string; createdAt: number }[];
}

export async function loadConversionEvents(db: D1Database, now = Date.now()): Promise<ConversionSnapshot> {
  const day = shanghaiDay(now);
  const [counts, recent] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT name,count(*) n FROM conversion_events WHERE day=? GROUP BY name ORDER BY name').bind(day),
    db
      .prepare('SELECT name,props,created_at createdAt FROM conversion_events ORDER BY created_at DESC LIMIT 20'),
  ]);
  const byName = new Map((counts?.results ?? []).map((r) => [String(r.name), Number(r.n)]));
  return {
    day,
    counts: CONVERSION_EVENTS.map((name) => ({ name, n: byName.get(name) ?? 0 })),
    recent: (recent?.results ?? []).map((r) => ({
      name: String(r.name),
      props: String(r.props ?? '{}'),
      createdAt: Number(r.createdAt),
    })),
  };
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

const LABELS: Record<ConversionEventName, string> = {
  home_view: '首页加载',
  upload_photo: '选中照片',
  render_click: '点击渲染',
  signin_open: '打开登录',
  pay_panel_view: '看到付款',
  pay_success: '支付成功',
  gen_fail: '生成失败',
  manual_review_submit: '提交审核',
};

export function renderConversionEvents(s: ConversionSnapshot): string {
  const clock = (n: number) =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(n);
  const countRows = s.counts
    .map((c) => `<tr><td>${esc(LABELS[c.name as ConversionEventName] ?? c.name)}</td><td>${c.n}</td></tr>`)
    .join('');
  const recentRows = s.recent.length
    ? s.recent
        .map(
          (r) =>
            `<tr><td>${esc(clock(r.createdAt))}</td><td>${esc(LABELS[r.name as ConversionEventName] ?? r.name)}</td><td>${esc(r.props)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="3">暂无事件</td></tr>';
  return `<details class="sec"><summary>转化事件（今日 ${esc(s.day)} / 最近 20 条）</summary>
  <p class="muted">第一方记录；若尚未配置 GA4 或 Umami，仍可在此查看这 8 个漏斗事件。手动刷新页面会更新。不计入访客 UV 或实时在线。</p>
  <div class="grid3"><div><h3>今日次数</h3><div class="scroll"><table><thead><tr><th>事件</th><th>次数</th></tr></thead><tbody>${countRows}</tbody></table></div></div>
  <div style="grid-column:span 2"><h3>最近 20 条</h3><div class="scroll"><table><thead><tr><th>时间</th><th>事件</th><th>属性</th></tr></thead><tbody>${recentRows}</tbody></table></div></div></div>
  </details>`;
}
