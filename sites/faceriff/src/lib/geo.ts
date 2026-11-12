// Country + browser language for localization decisions. No raw IP; Accept-Language reduced to a short whitelisted tag.

const BASES = new Set(
  'en es pt de fr it nl ja zh ko ru pl tr ar hi id vi th sv da nb fi cs uk he el ro hu ms fil bg hr sk sl lt lv et sr ca bn fa ta ur'.split(
    ' ',
  ),
);
const ALIASES: Record<string, string> = { no: 'nb', nn: 'nb', tl: 'fil', iw: 'he', in: 'id', ji: 'yi' };

/** First (highest-q) Accept-Language entry → { language: 'en-US' | 'pt-BR' | 'de' | 'zh-CN' …, base: 'en' }. */
export function browserLanguage(header: string | null | undefined): { language: string; base: string } {
  if (!header?.trim()) return { language: 'unknown', base: 'unknown' };
  let best = '';
  let bestQ = -1;
  for (const part of header.slice(0, 256).split(',').slice(0, 12)) {
    const [tag = '', ...params] = part.trim().split(';');
    const q = params.map((p) => /^\s*q=([01](?:\.\d{0,3})?)\s*$/.exec(p)?.[1]).find(Boolean);
    const weight = q == null ? 1 : Number(q);
    if (tag && tag !== '*' && weight > bestQ) {
      best = tag.trim();
      bestQ = weight;
    }
  }
  const parts = best.split(/[-_]/);
  const rawBase = (parts[0] ?? '').toLowerCase();
  const base = ALIASES[rawBase] ?? rawBase;
  if (!/^[a-z]{2,3}$/.test(base) || !BASES.has(base)) return { language: 'other', base: 'other' };
  let region = '';
  for (const p of parts.slice(1)) {
    if (/^[A-Za-z]{2}$/.test(p) || p === '419') {
      region = p.toUpperCase();
      break;
    }
    if (base === 'zh' && /^hans$/i.test(p)) region = 'CN';
    if (base === 'zh' && /^hant$/i.test(p)) region = 'TW';
    if (region) break;
  }
  return { language: region ? `${base}-${region}` : base, base };
}

export function requestCountry(request: Request): string {
  const c = (request.cf as { country?: unknown } | undefined)?.country;
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) ? c : 'ZZ';
}
export function requestGeo(request: Request) {
  return { country: requestCountry(request), ...browserLanguage(request.headers.get('accept-language')) };
}

const EUROPE = new Set(
  'AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS SE SI SJ SK SM UA VA XK'.split(
    ' ',
  ),
);
/** Market bucket used by the admin summary. */
export function marketOf(country: string | null | undefined): 'us' | 'ca' | 'europe' | 'other' | 'unknown' {
  if (!country || country === 'ZZ') return 'unknown';
  if (country === 'US') return 'us';
  if (country === 'CA') return 'ca';
  return EUROPE.has(country) ? 'europe' : 'other';
}

/** After a successful checkout response: stamp the new order with the buyer's country/language (once). */
export async function stampCheckout(db: D1Database, request: Request, response: Response): Promise<void> {
  if (!response.ok) return;
  const body = (await response.clone().json()) as { orderId?: unknown };
  if (typeof body.orderId !== 'string') return;
  const g = requestGeo(request);
  await db
    .prepare('UPDATE orders SET country=?,language=? WHERE id=? AND country IS NULL')
    .bind(g.country, g.language, body.orderId)
    .run();
}
/** After the buyer's own return-page sync reports paid: stamp where they were when paying (once). Webhooks carry no buyer location. */
export async function stampPaid(db: D1Database, request: Request, response: Response): Promise<void> {
  if (!response.ok) return;
  const body = (await response.clone().json()) as { orderId?: unknown; status?: unknown };
  if (typeof body.orderId !== 'string' || body.status !== 'paid') return;
  const g = requestGeo(request);
  await db
    .prepare('UPDATE orders SET paid_country=?,paid_language=? WHERE id=? AND paid_country IS NULL')
    .bind(g.country, g.language, body.orderId)
    .run();
}
export const SIGNUP_WINDOW = 15 * 60_000;
/**
 * After an auth response that sets a session cookie: if that account was created in the last 15 minutes and has no
 * signup location yet, stamp it. Existing accounts signing in again are untouched.
 */
export async function stampSignup(
  db: D1Database,
  request: Request,
  response: Response,
  userIdFor: (headers: Headers) => Promise<string | null>,
  now = Date.now(),
): Promise<void> {
  const cookies = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]?.trim() ?? '')
    .filter((c) => /session_token=[^;]+/.test(c));
  if (!cookies.length) return;
  const userId = await userIdFor(new Headers({ cookie: cookies.join('; ') }));
  if (!userId) return;
  const g = requestGeo(request);
  await db
    .prepare(
      'UPDATE user_attribution SET signup_country=?,signup_language=? WHERE user_id=? AND signup_country IS NULL AND created_at>=?',
    )
    .bind(g.country, g.language, userId, now - SIGNUP_WINDOW)
    .run();
}
/** Never let analytics break auth or billing. */
export async function safely(task: () => Promise<void>, event: string): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(JSON.stringify({ event, message: error instanceof Error ? error.message : 'unknown' }));
  }
}
