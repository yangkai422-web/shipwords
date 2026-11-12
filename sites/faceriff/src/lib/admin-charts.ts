// Owner dashboard: realtime visitors and plain-SVG charts (no chart library, no external requests).
import { type Charts, HOUR, type Realtime } from './realtime';

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
const fmt = (n: number, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, ...opts }).format(n);
export const clock = (n: number) =>
  fmt(n, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export type Label = (dimension: string, value: string) => string;
export const pageLabel = (path: string) =>
  path === '/'
    ? '首页 /'
    : path === 'other'
      ? '其他页面（未列入白名单）'
      : path === '/phone/*'
        ? '手机上传页 /phone/*'
        : path;

/** JSON for /api/admin/realtime: labels resolved on the server, no raw identifiers. */
export function realtimeJson(r: Realtime, label: Label) {
  return {
    now: r.now,
    updated: clock(r.now),
    startedAt: r.startedAt,
    online5: r.online5,
    online30: r.online30,
    views5: r.views5,
    views30: r.views30,
    perMinute: r.perMinute,
    series: r.series,
    pages: r.pages.map((p) => ({
      label: pageLabel(p.path),
      active5: p.active5,
      visitors: p.visitors,
      views: p.views,
    })),
    countries: r.countries.map((c) => ({ label: label('country', c.value), visitors: c.visitors })),
    devices: r.devices.map((c) => ({ label: label('device', c.value), visitors: c.visitors })),
  };
}

const W = 640;
const H = 240;
const PAD = { l: 40, r: 12, t: 14, b: 30 };
const niceMax = (n: number) => {
  if (n <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(n));
  const m = [1, 2, 2.5, 5, 10].find((k) => k * p >= n) ?? 10;
  return m * p;
};
function axes(max: number, labels: string[], every: number, step: number, offset: number): string {
  const ih = H - PAD.t - PAD.b;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const y = PAD.t + ih - (ih * i) / 4;
    g += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" class="grid"/><text x="${PAD.l - 6}" y="${y + 4}" text-anchor="end">${Math.round((max * i) / 4)}</text>`;
  }
  labels.forEach((l, i) => {
    if (i % every === 0 || i === labels.length - 1)
      g += `<text x="${(PAD.l + offset + i * step).toFixed(1)}" y="${H - 9}" text-anchor="middle">${esc(l)}</text>`;
  });
  return g;
}
export interface Series {
  name: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
}
/** Line chart; null values leave gaps (never drawn as zero). */
export function lineChart(
  title: string,
  labels: string[],
  series: Series[],
  every: number,
  tips: string[] = labels,
): string {
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0))));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const step = labels.length > 1 ? iw / (labels.length - 1) : 0;
  const y = (v: number) => (PAD.t + ih - (ih * v) / max).toFixed(1);
  const lines = series
    .map((s) => {
      let d = '';
      let pen = false;
      const dots: string[] = [];
      s.values.forEach((v, i) => {
        if (v == null) {
          pen = false;
          return;
        }
        const x = (PAD.l + i * step).toFixed(1);
        d += `${pen ? 'L' : 'M'}${x} ${y(v)}`;
        pen = true;
        dots.push(
          `<circle cx="${x}" cy="${y(v)}" r="${labels.length > 40 ? 1.6 : 2.6}" fill="${s.color}"><title>${esc(tips[i])} · ${esc(s.name)}：${v}</title></circle>`,
        );
      });
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"${s.dashed ? ' stroke-dasharray="5 4"' : ''}/>${dots.join('')}`;
    })
    .join('');
  return chartBox(title, series, `${axes(max, labels, every, step, 0)}${lines}`);
}
/** Bars per label: each group is a side-by-side bar; series inside a group are stacked. */
export function barChart(title: string, labels: string[], groups: Series[][], every: number): string {
  const totals = labels.map((_, i) => groups.map((g) => g.reduce((n, s) => n + (s.values[i] ?? 0), 0)));
  const max = niceMax(Math.max(0, ...totals.flat()));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const step = iw / Math.max(1, labels.length);
  const bw = Math.max(1.5, (step * 0.8) / groups.length);
  let bars = '';
  labels.forEach((label, i) => {
    groups.forEach((g, gi) => {
      let base = 0;
      const x = PAD.l + i * step + step * 0.1 + gi * bw;
      for (const s of g) {
        const v = s.values[i] ?? 0;
        if (v <= 0) continue;
        const h = (ih * v) / max;
        bars += `<rect x="${x.toFixed(1)}" y="${(PAD.t + ih - base - h).toFixed(1)}" width="${(bw - 0.6).toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}"><title>${esc(label)} · ${esc(s.name)}：${v}</title></rect>`;
        base += h;
      }
    });
  });
  return chartBox(title, groups.flat(), `${axes(max, labels, every, step, step / 2)}${bars}`);
}
function chartBox(title: string, series: Series[], body: string): string {
  const legend = series
    .map(
      (s) =>
        `<span><i style="background:${s.color}${s.dashed ? ';opacity:.6' : ''}"></i>${esc(s.name)}${s.dashed ? '（虚线）' : ''}</span>`,
    )
    .join('');
  return `<figure class="chart"><figcaption>${esc(title)}</figcaption><div class="legend">${legend}</div><div class="sv"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${body}</svg></div></figure>`;
}
const PALETTE = ['#ff4d6d', '#c6f432', '#4cc9f0', '#ffb703', '#b388ff', '#2ec4b6', '#f72585', '#90a4ae'];
/** Horizontal share bars (HTML, wraps well on phones). Top 7 plus "others". */
export function shareBars(title: string, rows: { label: string; count: number }[], unit: string): string {
  const sorted = [...rows].sort((a, b) => b.count - a.count);
  const top = sorted.slice(0, 7);
  const rest = sorted.slice(7).reduce((n, r) => n + r.count, 0);
  if (rest) top.push({ label: '其余合计', count: rest });
  const total = sorted.reduce((n, r) => n + r.count, 0);
  const body = total
    ? top
        .map((r, i) => {
          const pct = (100 * r.count) / total;
          return `<div class="hb"><div class="hbl"><span>${esc(r.label)}</span><b>${r.count} · ${pct.toFixed(1)}%</b></div><div class="hbt"><i style="width:${pct.toFixed(1)}%;background:${PALETTE[i % PALETTE.length]}"></i></div></div>`;
        })
        .join('')
    : '<p class="muted">暂无记录</p>';
  return `<figure class="chart"><figcaption>${esc(title)} · ${esc(unit)} ${total}</figcaption>${body}</figure>`;
}
/** Donut for few-category shares (device). */
export function donut(title: string, rows: { label: string; count: number }[], unit: string): string {
  const total = rows.reduce((n, r) => n + r.count, 0);
  const c = 2 * Math.PI * 40;
  let offset = 0;
  const arcs = rows
    .map((r, i) => {
      const len = total ? (c * r.count) / total : 0;
      const arc = `<circle r="40" cx="60" cy="60" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 60 60)"><title>${esc(r.label)}：${r.count}</title></circle>`;
      offset += len;
      return arc;
    })
    .join('');
  const legend = rows
    .map(
      (r, i) =>
        `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(r.label)} ${r.count}（${total ? ((100 * r.count) / total).toFixed(1) : 0}%）</span>`,
    )
    .join('');
  return `<figure class="chart"><figcaption>${esc(title)} · ${esc(unit)} ${total}</figcaption>${total ? `<div class="donut"><svg viewBox="0 0 120 120" role="img" aria-label="${esc(title)}">${arcs}<text x="60" y="65" text-anchor="middle" class="big">${total}</text></svg><div class="legend col">${legend}</div></div>` : '<p class="muted">暂无记录</p>'}</figure>`;
}

function sparkBars(series: number[]): string {
  const max = Math.max(1, ...series);
  return series
    .map((v, i) => {
      const h = (36 * v) / max;
      return `<rect x="${i * 4}" y="${(38 - h).toFixed(1)}" width="3" height="${h.toFixed(1)}"><title>${v}</title></rect>`;
    })
    .join('');
}
const rowsHtml = (items: (string | number)[][], cols: number) =>
  items.length
    ? items.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${cols}">最近 30 分钟暂无访客</td></tr>`;

export function renderRealtime(r: Realtime, label: Label, nonce: string): string {
  const j = realtimeJson(r, label);
  return `<section id="realtime"><h2>实时访客 <span class="live">● 每 30 秒自动刷新</span></h2>
  <p class="muted">最后更新：<strong id="rt-updated">${esc(j.updated)}</strong>（北京时间）<span id="rt-status" class="warn"></span> · 实时数据开始于 ${r.startedAt ? esc(clock(r.startedAt)) : '尚无访问（部署后第一次访问开始）'}</p>
  <div class="cards rt"><section class="card"><div>在线（5 分钟内）</div><div class="value" id="rt-online5">${j.online5}</div><small>按当日哈希访客去重</small></section>
  <section class="card"><div>在线（30 分钟内）</div><div class="value" id="rt-online30">${j.online30}</div><small>排除机器人、/admin、/api</small></section>
  <section class="card"><div>浏览量 / 分钟</div><div class="value" id="rt-pm">${j.perMinute}</div><small>最近 5 分钟平均 · 30 分钟共 <span id="rt-views30">${j.views30}</span> 次</small></section>
  <section class="card"><div>最近 30 分钟每分钟浏览量</div><svg class="spark" viewBox="0 0 120 40" preserveAspectRatio="none"><g id="rt-spark">${sparkBars(j.series)}</g></svg><small>最右为当前分钟（未结束）</small></section></div>
  <div class="grid3"><div><h3>正在访问的页面 · 30 分钟</h3><div class="scroll"><table><thead><tr><th>页面</th><th>5 分钟</th><th>30 分钟访客</th><th>浏览</th></tr></thead><tbody id="rt-pages">${rowsHtml(
    j.pages.map((p) => [p.label, p.active5, p.visitors, p.views]),
    4,
  )}</tbody></table></div></div>
  <div><h3>国家 / 地区 · 30 分钟</h3><div class="scroll"><table><thead><tr><th>国家</th><th>访客</th></tr></thead><tbody id="rt-countries">${rowsHtml(
    j.countries.map((c) => [c.label, c.visitors]),
    2,
  )}</tbody></table></div></div>
  <div><h3>设备 · 30 分钟</h3><div class="scroll"><table><thead><tr><th>设备</th><th>访客</th></tr></thead><tbody id="rt-devices">${rowsHtml(
    j.devices.map((c) => [c.label, c.visitors]),
    2,
  )}</tbody></table></div></div></div>
  <script nonce="${esc(nonce)}">${REFRESH_SCRIPT}</script></section>`;
}

// Inline (nonce) script: fetches the admin-only JSON and updates text only (textContent, no HTML from data).
const REFRESH_SCRIPT = `(()=>{const $=(i)=>document.getElementById(i);
const fill=(id,items,cols)=>{const tb=$(id);tb.replaceChildren();if(!items.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=cols.length;td.textContent='最近 30 分钟暂无访客';tr.append(td);tb.append(tr);return}for(const it of items){const tr=document.createElement('tr');for(const c of cols){const td=document.createElement('td');td.textContent=String(it[c]);tr.append(td)}tb.append(tr)}};
const spark=(s)=>{const g=$('rt-spark'),max=Math.max(1,...s),ns='http://www.w3.org/2000/svg';g.replaceChildren();s.forEach((v,i)=>{const r=document.createElementNS(ns,'rect'),h=36*v/max;r.setAttribute('x',String(i*4));r.setAttribute('y',String(38-h));r.setAttribute('width','3');r.setAttribute('height',String(h));const t=document.createElementNS(ns,'title');t.textContent=String(v);r.append(t);g.append(r)})};
let busy=false;const tick=async()=>{if(busy)return;busy=true;try{const r=await fetch('/api/admin/realtime',{cache:'no-store',credentials:'same-origin',headers:{accept:'application/json'}});if(!r.ok)throw new Error(String(r.status));const d=await r.json();
$('rt-online5').textContent=d.online5;$('rt-online30').textContent=d.online30;$('rt-pm').textContent=d.perMinute;$('rt-views30').textContent=d.views30;$('rt-updated').textContent=d.updated;
fill('rt-pages',d.pages,['label','active5','visitors','views']);fill('rt-countries',d.countries,['label','visitors']);fill('rt-devices',d.devices,['label','visitors']);spark(d.series);$('rt-status').textContent=''}
catch(e){$('rt-status').textContent=' · 刷新失败（'+(e&&e.message==='404'?'登录可能已过期，请刷新页面':'稍后自动重试')+'）'}finally{busy=false}};
addEventListener('DOMContentLoaded',()=>document.querySelectorAll('.sv').forEach((e)=>{e.scrollLeft=e.scrollWidth}));setInterval(()=>{if(!document.hidden)tick()},30000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick()});})();`;

export function renderCharts(c: Charts, label: Label): string {
  const hourLabels = c.hourly.map((h) => `${String((h.hour + 8) % 24).padStart(2, '0')}时`);
  const hourTitles = c.hourly.map((h) =>
    fmt(h.hour * HOUR, { month: '2-digit', day: '2-digit', hour: '2-digit' }),
  );
  const dayLabels = c.daily.map((d) => d.day.slice(5));
  const dims = (d: string) =>
    c.dimensions.filter((r) => r.dimension === d).map((r) => ({ label: label(d, r.value), count: r.count }));
  const hourly = lineChart(
    '最近 48 小时 · 每小时访客（北京时间）',
    hourLabels,
    [
      { name: '访客（小时内去重）', color: '#ff4d6d', values: c.hourly.map((h) => h.visitors) },
      { name: '浏览量', color: '#4cc9f0', values: c.hourly.map((h) => h.views) },
    ],
    6,
    hourTitles,
  );
  return `<section id="charts"><h2>趋势图表</h2>
  <div class="notice">实线 = 第一方统计（北京时间日 / 小时，排除机器人、后台和 API）；虚线 = Cloudflare 历史导入（UTC 日，全站 zone，含部分机器人和静态请求）。两种来源口径不同，不相加。缺失的时段留空，不画成 0。小时图从实时统计开始（${c.realtimeStartedAt ? esc(clock(c.realtimeStartedAt)) : '尚未开始'}）之后才有数据，保留 48 小时；第一方浏览量同样从这次部署后开始。</div>
  <div class="charts">${hourly}
  ${lineChart(
    `最近 30 天 · 每日访客 / 浏览量（${c.fromDay} 至 ${c.toDay}）`,
    dayLabels,
    [
      { name: '第一方访客 UV · 北京时间', color: '#ff4d6d', values: c.daily.map((d) => d.visitors) },
      { name: '第一方浏览量 PV · 北京时间', color: '#4cc9f0', values: c.daily.map((d) => d.views) },
      {
        name: 'Cloudflare UV · UTC',
        color: '#ffb703',
        values: c.daily.map((d) => d.cfVisitors),
        dashed: true,
      },
      { name: 'Cloudflare PV · UTC', color: '#b388ff', values: c.daily.map((d) => d.cfViews), dashed: true },
    ],
    5,
  )}
  ${barChart(
    '最近 30 天 · 每日订单与生成任务（北京时间，按创建日）',
    dayLabels,
    [
      [{ name: '订单（创建）', color: '#90a4ae', values: c.daily.map((d) => d.orders) }],
      [
        { name: '成功', color: '#c6f432', values: c.daily.map((d) => d.succeeded) },
        { name: '待审核', color: '#ffb703', values: c.daily.map((d) => d.review) },
        { name: '失败', color: '#ff4d6d', values: c.daily.map((d) => d.failed) },
      ],
    ],
    5,
  )}</div>
  <h3>访客构成 · 最近 30 天第一方（每日首访 UV，北京时间）</h3>
  <div class="charts small">${donut('设备', dims('device'), 'UV')}${shareBars('国家 / 地区', dims('country'), 'UV')}${shareBars('操作系统', dims('os'), 'UV')}${shareBars('浏览器', dims('browser'), 'UV')}${shareBars('来源平台（Referer）', dims('referrer'), 'UV')}</div>
  <details><summary>图表数据（逐日数字）</summary><div class="scroll"><table><thead><tr><th>日期</th><th>第一方 UV</th><th>第一方 PV</th><th>CF UV · UTC</th><th>CF PV · UTC</th><th>订单</th><th>付款订单</th><th>成功</th><th>待审核</th><th>失败</th></tr></thead><tbody>${c.daily
    .map(
      (d) =>
        `<tr>${[d.day, d.visitors ?? '未采集', d.views ?? '未采集', d.cfVisitors ?? '—', d.cfViews ?? '—', d.orders, d.paidOrders, d.succeeded, d.review, d.failed].map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`,
    )
    .join('')}</tbody></table></div></details></section>`;
}

export const CHART_CSS = `.live{font-size:12px;color:#c6f432;font-weight:400}.warn{color:#ff9aaf}.spark{width:100%;height:46px;fill:#4cc9f0;display:block;margin:8px 0}.grid3{display:grid;grid-template-columns:2fr 1fr 1fr;gap:14px}.charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.charts.small{grid-template-columns:repeat(3,minmax(0,1fr))}.chart{margin:0;background:#151b33;border:1px solid #eef0ff1f;border-radius:14px;padding:14px;min-width:0}.chart figcaption{font-weight:600;margin-bottom:6px}.chart svg{width:100%;height:auto;display:block;overflow:visible}.chart text{fill:#aeb5d4;font:11px system-ui,sans-serif}.chart text.big{fill:#eef0ff;font:700 20px ui-monospace,monospace}.chart .grid{stroke:#eef0ff1a}.legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:#c9cde8;margin-bottom:6px}.legend.col{flex-direction:column}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}.donut{display:flex;align-items:center;gap:14px}.donut svg{width:120px;flex:none}.hb{margin:6px 0}.hbl{display:flex;justify-content:space-between;gap:8px;font-size:13px}.hbl span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hbl b{font-weight:500;color:#c9cde8;white-space:nowrap}.hbt{height:8px;background:#0b1020;border-radius:4px;overflow:hidden}.hbt i{display:block;height:100%}@media(max-width:900px){.charts,.charts.small,.grid3{grid-template-columns:1fr}.chart text{font-size:13px}}@media(max-width:640px){.sv{overflow-x:auto}.sv svg{min-width:580px}.donut svg{width:100px}}`;
