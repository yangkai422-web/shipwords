export const dimensionNames = {
  country: '国家 / 地区',
  device: '设备类型',
  os: '操作系统',
  browser: '浏览器',
  referrer: '来源平台（Referer）',
  utm_source: 'UTM 来源（utm_source）',
} as const;
export type VisitorDimension = keyof typeof dimensionNames;

// Only recognized platform names survive. Unknown hosts/subdomains can contain identifiers.
export function referrerPlatform(host: string): string {
  const h = host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  if (!h) return 'direct';
  const platforms: [string, string[]][] = [
    ['internal', ['faceriff.com']],
    ['x', ['x.com', 'twitter.com', 't.co']],
    ['producthunt', ['producthunt.com']],
    ['reddit', ['reddit.com', 'redd.it']],
    [
      'google',
      [
        'google.com',
        'google.co.uk',
        'google.co.jp',
        'google.com.hk',
        'google.com.tw',
        'google.ca',
        'google.de',
        'google.fr',
        'google.co.in',
      ],
    ],
    ['bing', ['bing.com']],
    ['baidu', ['baidu.com']],
    ['facebook', ['facebook.com', 'fb.com']],
    ['instagram', ['instagram.com']],
    ['youtube', ['youtube.com', 'youtu.be']],
    ['tiktok', ['tiktok.com']],
    ['linkedin', ['linkedin.com']],
    ['github', ['github.com']],
    ['hackernews', ['news.ycombinator.com']],
    ['chatgpt', ['chatgpt.com', 'chat.openai.com']],
    ['perplexity', ['perplexity.ai']],
  ];
  return platforms.find(([, hosts]) => hosts.some((x) => h === x || h.endsWith(`.${x}`)))?.[0] ?? 'other';
}
export function visitorDimensions(request: Request): Record<VisitorDimension, string> {
  const ua = request.headers.get('user-agent') ?? '';
  const country = request.cf?.country;
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod|Macintosh.*Mobile/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /CrOS/i.test(ua)
          ? 'ChromeOS'
          : /Macintosh|Mac OS X/i.test(ua)
            ? 'macOS'
            : /Linux/i.test(ua)
              ? 'Linux'
              : 'unknown';
  const browser = /Edg[AiOS]*\//i.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/i.test(ua)
      ? 'Opera'
      : /SamsungBrowser/i.test(ua)
        ? 'Samsung Internet'
        : /Chrome\/|CriOS\//i.test(ua)
          ? 'Chrome'
          : /Firefox\/|FxiOS\//i.test(ua)
            ? 'Firefox'
            : /Safari\//i.test(ua)
              ? 'Safari'
              : /MSIE|Trident/i.test(ua)
                ? 'IE'
                : 'unknown';
  const device =
    /iPad|Tablet|Macintosh.*Mobile/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))
      ? 'tablet'
      : /Mobile|iPhone|iPod/i.test(ua)
        ? 'mobile'
        : os !== 'unknown'
          ? 'desktop'
          : 'unknown';
  let referrer = 'direct';
  const rawReferrer = request.headers.get('referer');
  if (rawReferrer) {
    try {
      const url = new URL(rawReferrer);
      referrer = /^https?:$/.test(url.protocol) ? referrerPlatform(url.hostname) : 'unknown';
    } catch {
      referrer = 'unknown';
    }
  }
  const tag = new URL(request.url).searchParams.get('utm_source')?.trim().toLowerCase();
  // Campaign labels only; reject URLs, emails, IPs, paths and excessively long values.
  const utm_source = !tag ? '__none__' : /^[a-z][a-z0-9_-]{0,39}$/.test(tag) ? tag : '__redacted__';
  return {
    country: typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country : 'ZZ',
    device,
    os,
    browser,
    referrer,
    utm_source,
  };
}
