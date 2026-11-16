import { sitemapXml } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import { SITEMAP_PAGES } from '~/site/guide-paths';
import site from '../../site.config';

// Register new indexable pages here.
export const PAGES = SITEMAP_PAGES;

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: () =>
        sitemapXml(
          site,
            PAGES.map((path) => (path === '/' ? { path, lastmod: '2026-11-08' } : { path })),
        ),
    },
  },
});
