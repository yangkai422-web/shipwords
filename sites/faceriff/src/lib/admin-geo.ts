// Owner dashboard: localization data (visitor languages, conversion by country / language, market summary). Last 30 Shanghai days.
import { shareBars } from './admin-charts';
import { DAY, shanghaiDay } from './admin-data';
import { marketOf } from './geo';

export interface Funnel {
  key: string;
  visitors: number;
  signups: number;
  orders: number;
  paid: number;
  revenue: number;
}
export interface GeoData {
  fromDay: string;
  toDay: string;
  /** First Shanghai day with a recorded visitor language (null = none yet). */
  languageSince: string | null;
  languages: { value: string; count: number }[];
  byCountry: Funnel[];
  byLanguage: Funnel[];
  markets: Funnel[];
}
const UNRECORDED = '__unrecorded__';
const baseOf = (language: string | null | undefined) =>
  !language
    ? UNRECORDED
    : language === 'unknown' || language === 'other'
      ? language
      : (language.split('-')[0] ?? language);

export async function loadGeo(db: D1Database, now = Date.now()): Promise<GeoData> {
  const toDay = shanghaiDay(now);
  const fromDay = shanghaiDay(now - 29 * DAY);
  const start = Date.parse(`${fromDay}T00:00:00+08:00`);
  const end = Date.parse(`${toDay}T00:00:00+08:00`) + DAY;
  const q = (sql: string, ...p: (string | number)[]) => db.prepare(sql).bind(...p);
  const [dims, since, signups, orders, paid] = await db.batch<Record<string, unknown>>([
    q(
      `SELECT dimension,value,sum(count) count FROM daily_visitor_dimensions WHERE day BETWEEN ? AND ?
      AND dimension IN ('country','language','lang_base') GROUP BY dimension,value`,
      fromDay,
      toDay,
    ),
    db.prepare("SELECT min(day) day FROM daily_visitor_dimensions WHERE dimension='language'"),
    q(
      `SELECT a.signup_country country,a.signup_language language,count(*) n FROM user u
      LEFT JOIN user_attribution a ON a.user_id=u.id WHERE u.created_at>=? AND u.created_at<? GROUP BY 1,2`,
      start,
      end,
    ),
    q(
      'SELECT country,language,count(*) n FROM orders WHERE created_at>=? AND created_at<? GROUP BY 1,2',
      start,
      end,
    ),
    q(
      `SELECT country,language,count(*) n,coalesce(sum(CASE WHEN lower(currency)='usd' THEN amount END),0)/100.0 revenue
      FROM orders WHERE paid_at>=? AND paid_at<? GROUP BY 1,2`,
      start,
      end,
    ),
  ]);
  const funnels = new Map<string, Map<string, Funnel>>([
    ['country', new Map()],
    ['language', new Map()],
    ['market', new Map()],
  ]);
  const row = (kind: string, key: string) => {
    const m = funnels.get(kind)!;
    let f = m.get(key);
    if (!f) {
      f = { key, visitors: 0, signups: 0, orders: 0, paid: 0, revenue: 0 };
      m.set(key, f);
    }
    return f;
  };
  const add = (country: unknown, language: unknown, field: keyof Omit<Funnel, 'key'>, n: number) => {
    const c = typeof country === 'string' && country ? country : UNRECORDED;
    row('country', c)[field] += n;
    row('language', baseOf(typeof language === 'string' ? language : null))[field] += n;
    row('market', c === UNRECORDED ? UNRECORDED : marketOf(c))[field] += n;
  };
  const languages: GeoData['languages'] = [];
  for (const r of dims?.results ?? []) {
    const n = Number(r.count);
    if (r.dimension === 'country') {
      row('country', String(r.value)).visitors += n;
      row('market', marketOf(String(r.value))).visitors += n;
    } else if (r.dimension === 'lang_base') row('language', String(r.value)).visitors += n;
    else languages.push({ value: String(r.value), count: n });
  }
  for (const r of signups?.results ?? []) add(r.country, r.language, 'signups', Number(r.n));
  for (const r of orders?.results ?? []) add(r.country, r.language, 'orders', Number(r.n));
  for (const r of paid?.results ?? []) {
    add(r.country, r.language, 'paid', Number(r.n));
    add(r.country, r.language, 'revenue', Number(r.revenue));
  }
  const sorted = (kind: string) =>
    [...funnels.get(kind)!.values()].sort(
      (a, b) =>
        b.revenue - a.revenue || b.paid - a.paid || b.visitors - a.visitors || a.key.localeCompare(b.key),
    );
  const marketOrder = ['us', 'ca', 'europe', 'other', 'unknown', UNRECORDED];
  return {
    fromDay,
    toDay,
    languageSince: typeof since?.results[0]?.day === 'string' ? (since.results[0].day as string) : null,
    languages: languages.sort((a, b) => b.count - a.count),
    byCountry: sorted('country'),
    byLanguage: sorted('language'),
    markets: marketOrder.map(
      (k) =>
        funnels.get('market')!.get(k) ?? { key: k, visitors: 0, signups: 0, orders: 0, paid: 0, revenue: 0 },
    ),
  };
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
const languageNames = new Intl.DisplayNames(['zh-CN'], { type: 'language' });
export function languageLabel(tag: string): string {
  if (tag === UNRECORDED) return '未记录（部署前 / 无语言）';
  if (tag === 'unknown') return '未提供';
  if (tag === 'other') return '其他 / 无法识别';
  try {
    return `${tag} · ${languageNames.of(tag) ?? tag}`;
  } catch {
    return tag;
  }
}
const MARKETS: Record<string, string> = {
  us: '美国',
  ca: '加拿大',
  europe: '欧洲（含英国、瑞士、挪威等）',
  other: '其他国家 / 地区',
  unknown: '未知国家（ZZ）',
  [UNRECORDED]: '未记录（部署前）',
};
const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : '—');
function funnelTable(first: string, rows: Funnel[], label: (key: string) => string, limit = 25): string {
  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit);
  if (rest.length)
    shown.push(
      rest.reduce(
        (a, r) => ({
          key: '其余合计',
          visitors: a.visitors + r.visitors,
          signups: a.signups + r.signups,
          orders: a.orders + r.orders,
          paid: a.paid + r.paid,
          revenue: a.revenue + r.revenue,
        }),
        { key: '其余合计', visitors: 0, signups: 0, orders: 0, paid: 0, revenue: 0 },
      ),
    );
  const body = shown
    .map(
      (r) =>
        `<tr>${[
          r.key === '其余合计' ? r.key : label(r.key),
          r.visitors,
          r.signups,
          r.orders,
          r.paid,
          `$${r.revenue.toFixed(2)}`,
          pct(r.signups, r.visitors),
          pct(r.paid, r.visitors),
          pct(r.paid, r.orders),
        ]
          .map((v) => `<td>${esc(v)}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<div class="scroll"><table><thead><tr><th>${esc(first)}</th><th>访客 UV</th><th>注册</th><th>创建订单</th><th>付款订单</th><th>收款 USD</th><th>注册率</th><th>付款转化</th><th>订单付款率</th></tr></thead><tbody>${body || '<tr><td colspan="9">暂无记录</td></tr>'}</tbody></table></div>`;
}

export function renderGeo(g: GeoData, countryLabel: (code: string) => string): string {
  const m = Object.fromEntries(g.markets.map((r) => [r.key, r]));
  const sum = (keys: string[]) =>
    keys.reduce(
      (a, k) => {
        const r = m[k];
        return r
          ? {
              visitors: a.visitors + r.visitors,
              signups: a.signups + r.signups,
              orders: a.orders + r.orders,
              paid: a.paid + r.paid,
              revenue: a.revenue + r.revenue,
            }
          : a;
      },
      { visitors: 0, signups: 0, orders: 0, paid: 0, revenue: 0 },
    );
  const west = sum(['us', 'ca', 'europe']);
  const all = sum(Object.keys(m));
  const card = (title: string, f: Omit<Funnel, 'key'>, note: string) =>
    `<section class="card"><div>${esc(title)}</div><div class="value">${pct(f.visitors, all.visitors)}</div><small>访客占比 · ${f.visitors} UV · ${f.signups} 注册 · ${f.paid} 付款 · $${f.revenue.toFixed(2)}${note ? ` · ${esc(note)}` : ''}</small></section>`;
  const countryName = (k: string) => (k === UNRECORDED ? '未记录（部署前）' : countryLabel(k));
  return `<section id="geo"><h2>本地化决策 · 国家与语言（最近 30 天 ${esc(g.fromDay)} 至 ${esc(g.toDay)}，北京时间）</h2>
  <div class="notice">访客 = 第一方每日首访 UV 按日相加（排除机器人、后台、API）；注册 / 订单 / 付款按账号或订单记录的国家与浏览器首选语言（注册时、下单时）。国家来自 Cloudflare 网络出口位置（VPN 可能改变），不存 IP；语言只保留 Accept-Language 首选的短标签（如 en-US、pt-BR）。浏览器语言从 ${g.languageSince ? esc(g.languageSince) : '本次部署后第一次访问'} 开始记录；注册 / 订单的国家与语言从本次部署开始记录，此前的显示为「未记录」。样本很少时比例波动很大，仅作方向参考。</div>
  <div class="cards">${card('欧洲 + 北美', west, '美国、加拿大、欧洲合计')}${card('美国', m.us ?? west, '')}${card('欧洲', m.europe ?? west, '')}${card('其他 / 未知', sum(['other', 'unknown', UNRECORDED]), '')}</div>
  <h3>市场汇总</h3>${funnelTable('市场', g.markets, (k) => MARKETS[k] ?? k)}
  <div class="charts small">${shareBars(
    '访客浏览器语言（首选标签）',
    g.languages.map((l) => ({ label: languageLabel(l.value), count: l.count })),
    'UV',
  )}${shareBars(
    '访客基础语言',
    g.byLanguage
      .filter((r) => r.visitors > 0)
      .map((r) => ({ label: languageLabel(r.key), count: r.visitors })),
    'UV',
  )}${shareBars(
    '访客国家 / 地区',
    g.byCountry
      .filter((r) => r.visitors > 0 && r.key !== UNRECORDED)
      .map((r) => ({ label: countryName(r.key), count: r.visitors })),
    'UV',
  )}</div>
  <h3>按国家 / 地区转化</h3>${funnelTable('国家 / 地区', g.byCountry, countryName)}
  <h3>按浏览器基础语言转化</h3>${funnelTable('语言', g.byLanguage, languageLabel)}
  <p class="muted">注册率 = 注册 ÷ 访客；付款转化 = 付款订单 ÷ 访客；订单付款率 = 付款订单 ÷ 创建订单。付款按下单时记录的国家 / 语言归属（支付平台的 webhook 不带买家位置；买家回到网站时另存一份付款时位置供核对）。收款只算 USD。</p></section>`;
}
