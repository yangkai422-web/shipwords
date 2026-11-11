import { type Dashboard, dateRange, loadDashboard, visitorReference } from './admin-data';
import type { DimensionCount, TrafficDimensions } from './admin-dimensions';
import { dimensionNames } from './visitor-dimensions';

export interface AdminUser {
  email: string;
  emailVerified: boolean;
}
export interface AdminEnv {
  DB: D1Database;
  OUTPUTS: R2Bucket;
  ADMIN_EMAILS?: string;
}
export type GetAdminUser = (request: Request) => Promise<AdminUser | null>;
export function isAdmin(user: AdminUser | null, allowlist: string | undefined): boolean {
  const emails = (allowlist ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !!user?.emailVerified && emails.includes(user.email.trim().toLowerCase());
}
const secureHeaders = {
  'cache-control': 'private, no-store, max-age=0',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  vary: 'Cookie',
};
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { ...secureHeaders, 'content-type': 'text/html; charset=utf-8' } });
const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
const money = (n: number) => `$${n.toFixed(2)}`;
const time = (n: number | null) =>
  n == null
    ? '—'
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(n);
const status = (s: string, review = false) =>
  `<span class="badge ${s === 'succeeded' && !review ? 'good' : s === 'failed' ? 'bad' : ''}">${escapeHtml(review ? 'quality_review' : s)}</span>`;
const cells = (values: unknown[]) => `<tr>${values.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`;
const table = (heads: string[], body: string) =>
  `<div class="scroll"><table><thead><tr>${heads.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${heads.length}">此范围暂无记录</td></tr>`}</tbody></table></div>`;

const countries = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const dimensionLabel = (dimension: string, value: string) => {
  if (dimension === 'utm_source')
    return value === '__none__' ? '未设置' : value === '__redacted__' ? '已过滤（非安全标签）' : value;
  if (dimension === 'country') {
    if (value === 'ZZ') return '未知国家 / 地区';
    try {
      return `${value} · ${countries.of(value) ?? value}`;
    } catch {
      return value;
    }
  }
  return (
    (
      {
        desktop: '电脑',
        mobile: '手机',
        tablet: '平板',
        unknown: '未知 / 未识别',
        direct: '直接访问 / 未提供来源',
        internal: '站内来源',
        other: '其他平台（不保存原始域名）',
        x: 'X / Twitter',
        producthunt: 'Product Hunt',
        reddit: 'Reddit',
        google: 'Google',
        bing: 'Bing',
        baidu: '百度',
        none: '未设置',
        redacted: '已过滤（非安全标签）',
      } as Record<string, string>
    )[value] ?? value
  );
};
function breakdown(rows: DimensionCount[], dimension: string, unit: string): string {
  const values = rows
    .filter((r) => r.dimension === dimension)
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  const total = values.reduce((n, r) => n + r.count, 0);
  const entries = values
    .slice(0, 15)
    .map((r) => [
      dimensionLabel(dimension, r.value),
      r.count,
      total ? `${((100 * r.count) / total).toFixed(1)}%` : '—',
    ]);
  const rest = values.slice(15).reduce((n, r) => n + r.count, 0);
  if (rest) entries.push(['其余项目合计', rest, `${((100 * rest) / total).toFixed(1)}%`]);
  return (
    '<h3>' +
    escapeHtml(dimensionNames[dimension as keyof typeof dimensionNames] ?? dimension) +
    ' · ' +
    escapeHtml(unit) +
    ' ' +
    (values.length ? total : '未采集 / 无可用记录') +
    '</h3>' +
    table(['分类', unit, '占此维度全部记录'], entries.map(cells).join(''))
  );
}
function renderDimensions(d: TrafficDimensions): string {
  const first = Object.keys(dimensionNames)
    .map((key) => breakdown(d.firstParty, key, '每日首访 UV'))
    .join('');
  const cf = d.coverage
    .map(
      (c) =>
        '<h3>' +
        escapeHtml(c.dataset) +
        ' · ' +
        escapeHtml(dimensionNames[c.dimension as keyof typeof dimensionNames] ?? c.dimension) +
        '</h3><p>覆盖 ' +
        escapeHtml(c.fromDay) +
        ' 至 ' +
        escapeHtml(c.toDay) +
        '（' +
        c.days +
        ' 个 UTC 日）；抓取 ' +
        escapeHtml(time(c.fetchedAt)) +
        '（北京时间）。' +
        (c.partialDays ? `部分 UTC 日：${escapeHtml(c.partialDays)}。` : '') +
        '</p>' +
        breakdown(
          d.cloudflare.filter((r) => r.dataset === c.dataset),
          c.dimension,
          '请求数',
        ),
    )
    .join('');
  return (
    '<h2>访客详细来源</h2><div class="notice">来源独立展示，不相加。占比的分母是所选范围、同一来源、同一维度的全部记录（包含未知）；只显示前 15 类，其余合并。各维度是边际统计，不支持国家 × 设备等交叉画像。</div><h2>第一方 · 北京时间日 · 每日首访 UV</h2><p>维度采集启用：' +
    escapeHtml(time(d.startedAt)) +
    '（Asia/Shanghai）。仅记录每日首次符合条件的唯一访客；本次升级前已计入当日 UV 的访客不会追补，因此维度合计可能少于原访客合计。90 天滚动保留。</p><p>国家是网络出口位置，VPN / 代理可能改变；设备、系统和浏览器是粗粒度 UA 推测。来源只保存平台分类，未知域名归其他；直接访问也可能是浏览器未提供 Referer，站内来源不等于最初获客渠道。utm_source 单独展示，不覆盖 Referer；只保留最多 40 字符的安全活动标签，不要在标签中放个人信息。</p>' +
    first +
    '<h2>Cloudflare · UTC 日 · 请求数（含机器人）</h2><p>全站 zone 请求，含静态文件、API、后台、机器人；不是 UV / 真人数，也不是页面浏览 PV。Adaptive 为可能抽样的估计，可能与 daily countryMap 有差异。不同数据集分别展示，不能相加。范围外是未采集而非零，末日为截至抓取时快照，不会自动刷新。</p><p>历史 Referer：Cloudflare 拒绝此 zone 读取 clientRefererHost，未补录；历史 utm_source：此聚合数据集不提供，未补录。没有伪造直接访问或零值。</p>' +
    (cf || '<p>尚未导入 Cloudflare 来源维度。</p>')
  );
}
export function renderDashboard(data: Dashboard): string {
  const { totals: t, range: r } = data;
  const kpis = [
    [
      '第一方每日访客合计 · UTC+8',
      t.visitors == null ? '未采集' : t.visitors,
      '仅第一方数据；每日去重数相加，不是跨日独立人数',
    ],
    [
      'CF 每日 UV 合计 · UTC',
      t.cfVisitors == null ? '未导入' : t.cfVisitors,
      '按 UTC 日 UV 相加，非跨日去重；不与第一方相加',
    ],
    [
      'CF 浏览量 PV · UTC',
      t.cfPageViews == null ? '未导入' : t.cfPageViews,
      'Cloudflare HTML 页面浏览量；历史快照',
    ],
    [
      'CF 请求量 · UTC',
      t.cfRequests == null ? '未导入' : t.cfRequests,
      '包含静态文件、API 等请求，不是访客人数',
    ],
    ['新注册', t.signups, 'user.created_at'],
    ['已付款订单 (USD)', t.paidOrders, `${t.orders} 笔创建订单，含未付款`],
    ['收款 (USD)', money(t.revenue), '按订单 paid_at 归属日期'],
    ['生成任务', t.jobs, `${t.succeeded} 成功 · ${t.review} 待复核 · ${t.failed} 失败`],
    ['积分退回任务', t.creditRefunds, '不是现金退款；可能与失败数重叠'],
    ['Yir 成本*', money(t.yirCost), `${t.knownCostJobs} 个任务有记录 · ${t.estimatedCostJobs} 个任务估算`],
    ['估算差额*', money(t.margin), '收款 − 现金退款 − Yir 成本；不等于利润'],
  ];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>FaceRiff · 经营后台</title><style>
  *{box-sizing:border-box}body{margin:0;background:#0b1020;color:#eef0ff;font:14px/1.65 system-ui,sans-serif}main{max-width:1600px;margin:auto;padding:32px 24px}a{color:#ff839a}h1{font-size:30px;margin:0}h2{font-size:20px;margin:30px 0 10px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px}.tag{color:#c6f432;font-size:12px;letter-spacing:2px}p,.muted{color:#aeb5d4}.filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:24px 0}input,button,.pill{background:#151b33;border:1px solid #eef0ff30;color:#eef0ff;border-radius:8px;padding:9px 12px}button{background:#ff4d6d;color:#fff;cursor:pointer}.pill{text-decoration:none}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.card{background:#151b33;border:1px solid #eef0ff1f;border-radius:14px;padding:18px}.value{font:700 30px/1.4 ui-monospace,monospace;margin:6px 0}.card small{color:#aeb5d4}.notice{border-left:3px solid #c6f432;background:#151b33;padding:12px 16px;margin:18px 0}.scroll{overflow:auto;border:1px solid #eef0ff22;border-radius:12px}table{width:100%;border-collapse:collapse;white-space:nowrap;background:#10162a}th,td{padding:12px;text-align:left;border-bottom:1px solid #eef0ff16;font-variant-numeric:tabular-nums}th{color:#c9cde8;background:#151b33;position:sticky;top:0}tbody tr:hover{background:#151b33}.badge{padding:3px 8px;border-radius:6px;background:#3b3450;color:#ffe5a1}.good{background:#263c2c;color:#c6f432}.bad{background:#4c2435;color:#ff9aaf}details{background:#151b33;padding:16px;border-radius:12px;margin-top:20px}li{margin:7px 0}footer{margin:28px 0;color:#8f95b8}@media(max-width:900px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}main{padding:20px 12px}}@media(max-width:480px){.cards{grid-template-columns:1fr}.top{display:block}}
  </style></head><body><main><header class="top"><div><div class="tag">FACERIFF · OWNER ONLY</div><h1>经营与交付后台</h1><div class="muted">只读 · Asia/Shanghai (UTC+8) · ${escapeHtml(time(Date.now()))}</div></div><a href="/">返回网站</a></header>
  <form class="filters" method="get" action="/admin"><a class="pill" href="/admin?days=7">最近 7 天</a><a class="pill" href="/admin?days=30">最近 30 天</a><label>从 <input type="date" name="from" value="${r.from}" required></label><label>到 <input type="date" name="to" value="${r.to}" required></label><button type="submit">查看</button><span class="muted">最多 90 天 · 今天尚未结束</span></form>
  <div class="cards">${kpis.map(([label, value, note]) => `<section class="card"><div>${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><small>${escapeHtml(note)}</small></section>`).join('')}</div>
  <div class="notice">第一方访客统计启用：${escapeHtml(time(data.trackingStartedAt))}（Asia/Shanghai）。启用当日只有部分时段；此前如有 Cloudflare 历史数据则作为访客参考，否则显示「未采集」。无 Cookie；按当日 IP + 浏览器特征的 HMAC 去重，不存原始 IP / UA，排除已识别机器人、后台、API 和静态文件。保留最近 90 天；这是估计访客数，不是精确人数。</div>
  <div class="notice">Cloudflare 统计（含部分机器人，按 UTC 日）：${data.cfHistory ? `历史快照覆盖 ${escapeHtml(data.cfHistory.from)} 至 ${escapeHtml(data.cfHistory.to)}；抓取时间 ${escapeHtml(time(data.cfHistory.fetchedAt))}（Asia/Shanghai）。${data.cfHistory.partialDays.length ? ` UTC 日期 ${escapeHtml(data.cfHistory.partialDays.join('、'))} 为未结束日的截至抓取时快照。` : ''}` : '尚未导入。'} UTC 日期 11 月 10 日对应北京时间 11 月 10 日 08:00 至 11 月 11 日 08:00；未强行换算成北京时间日。CF 是全站 zone 汇总，可能含爬虫、威胁请求、后台和静态资源，其 UV 不等于真人数。CF UV 合计也是每日 UV 相加，不是整段时间的去重人数。两种口径不相加，也不能直接对齐订单计算转化率。仅一次性补录，不会自动刷新。</div>
  ${data.otherCurrencies.length ? `<div class="notice">非 USD 收款未混入美元统计：${data.otherCurrencies.map((c) => `${escapeHtml(c.currency.toUpperCase())} ${escapeHtml(c.amount.toFixed(2))}（${c.orders} 笔）`).join('；')}</div>` : ''}
  <h2>每日概览</h2><p>订单按创建日；收款按付款日；视频状态 / 成本 / 积分退回按任务创建日汇总，状态会随任务进展更新。注册、订单、任务按北京时间日；CF 列严格保留同名 UTC 日期。访客参考优先第一方，缺失时用 CF；各来源合计分开展示，CF 重叠日仅供参考。</p>
  ${table(['日期', '访客参考', '访客来源 / 日界线', 'CF UV · UTC', 'CF PV · UTC', 'CF 请求 · UTC', '注册', '创建订单', '付款 USD', '收款 USD', '视频', '成功', '待复核', '失败', '取消', '进行中', '退积分任务', 'Yir 次数', 'Yir 成本*', '现金退款 USD†', '差额*'], data.daily.map((d) => cells([d.day, visitorReference(d).value ?? '未采集', d.visitors != null ? '第一方 · UTC+8' : d.cfVisitors != null ? 'Cloudflare · UTC' : '未采集', d.cfVisitors ?? '—', d.cfPageViews ?? '—', d.cfRequests ?? '—', d.signups, d.orders, d.paidOrders, money(d.revenue), d.jobs, d.succeeded, d.review, d.failed, d.canceled, d.active, d.creditRefunds, d.generations, money(d.yirCost), money(d.cashRefund), money(d.margin)])).join(''))}
  ${renderDimensions(data.dimensions)}
  <h2>当前受限账号 / 模板 (${data.held.length}${data.held.length === 100 ? '+' : ''})</h2><p>全时段未解除的质量重试限制（quality_review_required）。这里只展示，不解锁、不扣积分。</p>
  ${table(['客户', '模板', '受限任务数', '最早任务 · Asia/Shanghai'], data.held.map((h) => cells([h.email, h.modelId, h.jobs, time(h.since)])).join(''))}
  <h2>最近订单（最多 100 笔）</h2><p>同账号视频列仅统计所选日期范围内的任务，<strong>不是逐笔订单的对应关系</strong>：现有系统是先买积分再生成，任务没有 order_id。</p>
  ${table(['订单', '客户', '商品', '支付状态', '金额', '创建 · Asia/Shanghai', '付款 · Asia/Shanghai', '现金已退', '同账号任务', '成功 / 待复核 / 失败'], data.orders.map((o) => `<tr><td>${escapeHtml(o.id)}</td><td>${escapeHtml(o.email)}</td><td>${escapeHtml(o.productId)}</td><td>${status(o.status)}</td><td>${escapeHtml(o.currency.toUpperCase())} ${(o.amount / 100).toFixed(2)}</td><td>${escapeHtml(time(o.createdAt))}</td><td>${escapeHtml(time(o.paidAt))}</td><td>${(o.cashRefund / 100).toFixed(2)}</td><td>${o.sameAccountJobs}</td><td>${o.succeeded} / ${o.review} / ${o.failed}</td></tr>`).join(''))}
  <h2>最近生成任务（最多 100 条）</h2>
  ${table(['任务', '客户', '模板', '结果', '错误码', '积分退回', '重试限制', '创建 · Asia/Shanghai', '完成 · Asia/Shanghai', '输出'], data.jobs.map((j) => `<tr><td>${escapeHtml(j.id)}</td><td>${escapeHtml(j.email)}</td><td>${escapeHtml(j.modelId)}</td><td>${status(j.status, j.status === 'succeeded' && j.errorCode === 'quality_review')}</td><td>${escapeHtml(j.errorCode ?? '—')}</td><td>${j.creditRefunded ? '已退' : '—'}</td><td>${j.held ? '受限' : '—'}</td><td>${escapeHtml(time(j.createdAt))}</td><td>${escapeHtml(time(j.finishedAt))}</td><td>${j.status === 'succeeded' && j.outputCount > 0 ? `<a href="/api/admin/output?job=${encodeURIComponent(j.id)}">下载成片</a>` : '—'}</td></tr>`).join(''))}
  <details open><summary>指标口径与限制</summary><ul><li>新注册来自 user；订单 / 收款来自 orders；任务来自 jobs；积分退回来自 credit_ledger 中 refund:job:* 记录，失败与退积分会重叠。quality_review 是已交付但待人工复核，不重复计入正常成功。</li><li>† 现金退款来自 payments.amount_refunded，按原订单付款日归属，不是退款实际发生日；记录以支付系统已同步到 D1 的状态为准。订单状态不等同于退款状态。</li><li>* Yir 成本优先用 jobs.upstream_cost_usd；没有账单记录时，按实际记录的上游任务 ID 数 × $2.7378 估算（不计 skipped 段）。提交前失败不计生成次数；上游已受理但 ID 未落库的异常费用无法捕捉。</li><li>差额 = USD 收款 − 同订单累计现金退款 − Yir 成本。包含所选范围的所有任务（含测试 / 重试），不含 Cloudflare、支付手续费、税费等，不是财务利润，也不是逐订单毛利。</li><li>第一方访客合计是每日去重数之和；共享 IP + 相同浏览器可能少计，切换网络可能多计，机器人过滤不可能完全准确。仅统计成功的 HTML 文档请求；不额外记录站内 SPA 跳转。</li><li>客户邮箱只显示掩码；不展示上传照片、提示词或登录令牌。成片下载也会重新检查站主登录。</li></ul></details><footer>FaceRiff · 仅站主可见 · 只读运营数据</footer></main></body></html>`;
}

export async function handleAdminRequest(
  request: Request,
  env: AdminEnv,
  getUser: GetAdminUser,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    !(
      url.pathname === '/admin' ||
      url.pathname.startsWith('/admin/') ||
      url.pathname === '/api/admin' ||
      url.pathname.startsWith('/api/admin/')
    )
  )
    return null;
  let user: AdminUser | null;
  try {
    user = await getUser(request);
  } catch {
    return html('登录状态暂时不可用，请稍后重试。', 503);
  }
  if (!isAdmin(user, env.ADMIN_EMAILS)) return html('Not found', 404);
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { ...secureHeaders, allow: 'GET, HEAD' } });
  if (url.pathname === '/api/admin/output') {
    const id = url.searchParams.get('job') ?? '';
    if (!/^job_[a-z0-9]+$/.test(id)) return html('未找到成片', 404);
    const job = await env.DB.prepare('SELECT status,outputs_json FROM jobs WHERE id=?')
      .bind(id)
      .first<{ status: string; outputs_json: string | null }>();
    let outputs: { key?: unknown; mediaType?: unknown }[] = [];
    try {
      outputs = JSON.parse(job?.outputs_json ?? '[]');
    } catch {
      /* no valid output */
    }
    const output = Array.isArray(outputs) ? outputs[0] : null;
    if (
      job?.status !== 'succeeded' ||
      typeof output?.key !== 'string' ||
      !new RegExp(`^jobs/${id}/[0-9]+\\.(mp4|webm)$`).test(output.key)
    )
      return html('未找到成片', 404);
    const object = await env.OUTPUTS.get(output.key);
    if (!object) return html('成片已过期或不存在', 404);
    return new Response(request.method === 'HEAD' ? null : object.body, {
      headers: {
        ...secureHeaders,
        'content-type': 'video/mp4',
        'content-disposition': `attachment; filename="faceriff-${id}.mp4"`,
      },
    });
  }
  if (!['/admin', '/admin/', '/api/admin/dashboard'].includes(url.pathname)) return html('Not found', 404);
  let range: ReturnType<typeof dateRange>;
  try {
    range = dateRange(url);
  } catch {
    return html('日期无效：结束日期不能晚于今天，范围最多 90 天。', 400);
  }
  try {
    const data = await loadDashboard(env.DB, range);
    if (url.pathname === '/api/admin/dashboard')
      return new Response(request.method === 'HEAD' ? null : JSON.stringify(data), {
        headers: { ...secureHeaders, 'content-type': 'application/json; charset=utf-8' },
      });
    return html(request.method === 'HEAD' ? '' : renderDashboard(data));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'admin_dashboard_error',
        message: error instanceof Error ? error.message : 'unknown',
      }),
    );
    return html('后台数据暂时不可用，请稍后刷新。', 503);
  }
}
