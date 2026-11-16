/** Indexable guide routes. sitemap, footer and tests share this list. */
export const GUIDE_PATHS = [
  '/how-to-make-outstanding-tiny-desk-ai-video',
  '/tiny-desk-template',
  '/outstanding-tiny-desk-ai-template',
  '/outstanding-tiny-desk-meme',
  '/tiny-desk-ai-free',
] as const;

export const LEGAL_PATHS = ['/privacy', '/terms', '/refunds', '/dmca'] as const;

export const SITEMAP_PAGES = ['/', ...GUIDE_PATHS, ...LEGAL_PATHS] as const;
