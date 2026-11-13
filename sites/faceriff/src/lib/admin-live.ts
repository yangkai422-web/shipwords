// Owner dashboard top: recent orders and jobs (auto-refreshed), today's summary, compact KPIs incl. Yir balance.
import site from '../../site.config';
import { AUTO_REFRESH_MS, AUTO_REFRESH_TEXT, clock } from './admin-charts';
import { DAY, shanghaiDay } from './admin-data';
import { MINUTE } from './realtime';
import type { YirBalanceView } from './yir-balance';

export interface Cell {
  t: string;
  href?: string;
  c?: string;
}
export interface Live {
  now: number;
  orders: {
    id: string;
    createdAt: number;
    paidAt: number | null;
    email: string | null;
    productId: string;
    amount: number;
    currency: string;
    status: string;
    refunded: number;
  }[];
  jobs: {
    id: string;
    createdAt: number;
    email: string | null;
    modelId: string;
    status: string;
    errorCode: string | null;
    cost: string | null;
  }[];
  today: {
    paidOrders: number;
    revenue: number;
    jobs: number;
    succeeded: number;
    failed: number;
    review: number;
    pendingReviews: number;
    uv: number;
  };
  online5: number;
}
export const LIVE_ROWS = 20;

export async function loadLive(db: D1Database, now = Date.now()): Promise<Live> {
  const today = shanghaiDay(now);
  const start = Date.parse(`${today}T00:00:00+08:00`);
  const end = start + DAY;
  const [orders, jobs, paid, made, pending, uv, online] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT o.id,o.created_at createdAt,o.paid_at paidAt,u.email,o.product_id productId,o.amount,o.currency,o.status,
        (SELECT coalesce(sum(p.amount_refunded),0) FROM payments p WHERE p.order_id=o.id) refunded
        FROM orders o LEFT JOIN user u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT ?`,
      )
      .bind(LIVE_ROWS),
    db
      .prepare(
        `SELECT j.id,j.created_at createdAt,u.email,j.model_id modelId,j.status,j.error_code errorCode,j.upstream_cost_usd cost
        FROM jobs j LEFT JOIN user u ON u.id=j.user_id ORDER BY j.created_at DESC LIMIT ?`,
      )
      .bind(LIVE_ROWS),
    db
      .prepare(
        "SELECT count(*) n,coalesce(sum(CASE WHEN lower(currency)='usd' THEN amount END),0)/100.0 revenue FROM orders WHERE paid_at>=? AND paid_at<?",
      )
      .bind(start, end),
    db
      .prepare(
        "SELECT count(*) n,coalesce(sum(status='succeeded'),0) ok,coalesce(sum(status='failed'),0) bad,coalesce(sum(status='needs_review'),0) review FROM jobs WHERE created_at>=? AND created_at<?",
      )
      .bind(start, end),
    db.prepare("SELECT count(*) n FROM jobs WHERE status='needs_review'"),
    db.prepare('SELECT count(*) n FROM daily_visitors WHERE day=?').bind(today),
    db
      .prepare('SELECT count(DISTINCT visitor) n FROM visitor_hits WHERE minute>=?')
      .bind(Math.floor(now / MINUTE) - 4),
  ]);
  const one = (r: D1Result<Record<string, unknown>> | undefined) => r?.results[0] ?? {};
  return {
    now,
    orders: (orders?.results ?? []) as unknown as Live['orders'],
    jobs: (jobs?.results ?? []) as unknown as Live['jobs'],
    today: {
      paidOrders: Number(one(paid).n ?? 0),
      revenue: Number(one(paid).revenue ?? 0),
      jobs: Number(one(made).n ?? 0),
      succeeded: Number(one(made).ok ?? 0),
      failed: Number(one(made).bad ?? 0),
      review: Number(one(made).review ?? 0),
      pendingReviews: Number(one(pending).n ?? 0),
      uv: Number(one(uv).n ?? 0),
    },
    online5: Number(one(online).n ?? 0),
  };
}

const productName = (id: string) => site.products.find((p) => p.id === id)?.name ?? id;
const short = (n: number) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(n);
function orderStatus(o: Live['orders'][number]): Cell {
  if (o.status === 'paid' && o.refunded > 0)
    return o.refunded >= o.amount ? { t: '已退款', c: 'bad' } : { t: '部分退款', c: 'bad' };
  if (o.status === 'paid') return { t: '已付款', c: 'good' };
  if (o.status === 'pending') return { t: '待付款' };
  if (o.status === 'expired') return { t: '已过期' };
  return { t: o.status };
}
function jobStatus(j: Live['jobs'][number]): Cell {
  if (j.status === 'needs_review') return { t: '待审核 →', c: 'bad', href: '/admin/review' };
  if (j.status === 'succeeded')
    return j.errorCode === 'quality_review' ? { t: '已交付·复核' } : { t: '成功', c: 'good' };
  if (j.status === 'failed') return { t: '失败', c: 'bad' };
  if (j.status === 'canceled') return { t: '已取消' };
  if (j.status === 'queued' || j.status === 'submitted') return { t: '生成中' };
  return { t: j.status };
}
const usd = (n: number) => `$${n.toFixed(2)}`;
export function yirKpi(y: YirBalanceView | null) {
  if (!y || y.available == null)
    return {
      value: '不可用',
      note: y?.error ? `余额接口暂不可用（${y.error}）` : '尚未获取',
      low: false,
      warn: '',
    };
  const stale = y.error ? ' · 刷新失败，显示上次数据' : '';
  return {
    value: usd(y.available),
    note: `约 ${y.jobsLeft} 个视频（均价 ${usd(y.avgJobCost)}）· 冻结 ${usd(y.held ?? 0)} · 低于 ${usd(y.warnBelow)} 提醒 · 获取于 ${clock(y.fetchedAt ?? 0)}${stale}`,
    low: y.low,
    warn: y.low
      ? `Yir 余额偏低：${usd(y.available)}，约够 ${y.jobsLeft} 个视频（提醒线 ${usd(y.warnBelow)}）。请尽快到 Yir 后台充值，余额不足时新任务会失败并自动退积分。`
      : '',
  };
}
export function liveJson(l: Live, yir: YirBalanceView | null) {
  const t = l.today;
  return {
    updated: clock(l.now),
    summary: `今日（北京时间）：付款订单 ${t.paidOrders} 笔 · 收款 ${usd(t.revenue)} · 生成任务 ${t.jobs} 个（成功 ${t.succeeded} / 失败 ${t.failed} / 待审核 ${t.review}）· 当前待审核 ${t.pendingReviews} 个`,
    pendingReviews: t.pendingReviews,
    online5: l.online5,
    todayUv: t.uv,
    yir: yirKpi(yir),
    orders: l.orders.map((o): Cell[] => [
      { t: short(o.createdAt) },
      { t: o.email ?? '—' },
      { t: productName(o.productId) },
      { t: `${o.currency.toUpperCase()} ${(o.amount / 100).toFixed(2)}` },
      orderStatus(o),
    ]),
    jobs: l.jobs.map((j): Cell[] => [
      { t: short(j.createdAt) },
      { t: j.email ?? '—' },
      { t: j.modelId },
      jobStatus(j),
      { t: j.errorCode ?? '—' },
      { t: j.cost && Number(j.cost) > 0 ? usd(Number(j.cost)) : '—' },
    ]),
  };
}
type LiveJson = ReturnType<typeof liveJson>;

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
const cellHtml = (c: Cell) => {
  const inner = c.href ? `<a href="${esc(c.href)}">${esc(c.t)}</a>` : esc(c.t);
  return `<td>${c.c ? `<span class="badge ${esc(c.c)}">${inner}</span>` : inner}</td>`;
};
const rows = (list: Cell[][], cols: number, empty: string) =>
  list.length
    ? list.map((r) => `<tr>${r.map(cellHtml).join('')}</tr>`).join('')
    : `<tr><td colspan="${cols}">${empty}</td></tr>`;
const head = (cols: string[]) => `<thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;

export function renderLive(j: LiveJson, nonce: string): string {
  return `<section id="live">
  <div class="warnbox" id="yir-warn"${j.yir.warn ? '' : ' hidden'}>${esc(j.yir.warn)}</div>
  <div class="summary"><strong id="live-summary">${esc(j.summary)}</strong><span class="muted"> · ${AUTO_REFRESH_TEXT} · 最后更新 <span id="live-updated">${esc(j.updated)}</span>（北京时间）<span id="live-status" class="warn"></span></span></div>
  <h2>最近订单</h2><div class="scroll"><table>${head(['时间', '邮箱', '套餐', '金额', '状态'])}<tbody id="live-orders">${rows(j.orders, 5, '暂无订单')}</tbody></table></div>
  <h2>最近生成任务</h2><div class="scroll"><table>${head(['时间', '邮箱', '模板', '状态', '错误码', 'Yir 成本'])}<tbody id="live-jobs">${rows(j.jobs, 6, '暂无任务')}</tbody></table></div>
  <div class="cards kpi"><section class="card"><div>在线（5 分钟内）</div><div class="value" id="k-online5">${j.online5}</div><small>排除机器人、后台、API</small></section>
  <section class="card"><div>今日访客 UV</div><div class="value" id="k-uv">${j.todayUv}</div><small>北京时间今日，按日去重</small></section>
  <section class="card${j.yir.low ? ' lowcard' : ''}" id="k-yir-card"><div>Yir 余额（可用）</div><div class="value" id="k-yir">${esc(j.yir.value)}</div><small id="k-yir-note">${esc(j.yir.note)}</small></section></div>
  <script nonce="${esc(nonce)}">${LIVE_SCRIPT}</script></section>`;
}

const LIVE_SCRIPT = `(()=>{const $=(i)=>document.getElementById(i);
const cells=(id,list,cols,empty)=>{const tb=$(id);tb.replaceChildren();if(!list.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=cols;td.textContent=empty;tr.append(td);tb.append(tr);return}
for(const r of list){const tr=document.createElement('tr');for(const c of r){const td=document.createElement('td');let el=td;if(c.c){const s=document.createElement('span');s.className='badge '+c.c;td.append(s);el=s}
if(c.href&&c.href.startsWith('/admin/')){const a=document.createElement('a');a.href=c.href;a.textContent=c.t;el.append(a)}else el.append(document.createTextNode(c.t));tr.append(td)}tb.append(tr)}};
let busy=false,last=Date.now();const tick=async()=>{if(busy)return;busy=true;last=Date.now();try{const r=await fetch('/api/admin/live',{cache:'no-store',credentials:'same-origin',headers:{accept:'application/json'}});if(!r.ok)throw new Error(String(r.status));const d=await r.json();
$('live-summary').textContent=d.summary;$('live-updated').textContent=d.updated;cells('live-orders',d.orders,5,'暂无订单');cells('live-jobs',d.jobs,6,'暂无任务');
$('k-online5').textContent=d.online5;$('k-uv').textContent=d.todayUv;$('k-yir').textContent=d.yir.value;$('k-yir-note').textContent=d.yir.note;$('k-yir-card').classList.toggle('lowcard',!!d.yir.low);
const w=$('yir-warn');w.textContent=d.yir.warn;w.hidden=!d.yir.warn;const b=$('review-count');if(b){b.textContent=d.pendingReviews;b.className='badge '+(d.pendingReviews>0?'bad':'good')}$('live-status').textContent=''}
catch(e){$('live-status').textContent=' · 刷新失败（'+(e&&e.message==='404'?'登录可能已过期，请刷新页面':'稍后自动重试')+'）'}finally{busy=false}};
let timer=null;const stop=()=>{if(timer){clearInterval(timer);timer=null}};const start=(immediate)=>{stop();if(immediate)tick();timer=setInterval(tick,${AUTO_REFRESH_MS})};document.addEventListener('visibilitychange',()=>{document.hidden?stop():start(true)});if(!document.hidden)start(false);})();`;

export const LIVE_CSS = `.summary{background:#151b33;border:1px solid #eef0ff1f;border-radius:12px;padding:12px 16px;margin:16px 0}.warnbox{background:#4c2435;border:1px solid #ff4d6d;color:#ffd6de;border-radius:12px;padding:12px 16px;margin:16px 0;font-weight:600}.cards.kpi{grid-template-columns:repeat(3,minmax(0,1fr));margin-top:18px}.lowcard{border-color:#ff4d6d;background:#2a1626}.lowcard .value{color:#ff9aaf}details.sec{background:#10162a;border:1px solid #eef0ff1f;border-radius:12px;padding:0 16px;margin:12px 0}details.sec>summary{cursor:pointer;padding:14px 0;font-size:17px;font-weight:600}details.sec[open]>summary{border-bottom:1px solid #eef0ff16;margin-bottom:8px}@media(max-width:700px){.cards.kpi{grid-template-columns:1fr}}`;
