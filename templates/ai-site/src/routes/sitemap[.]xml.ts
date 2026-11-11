import { sitemapXml } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import site from '../../site.config';

// Register new indexable pages here.
export const PAGES = ['/', '/privacy', '/terms', '/refunds', '/dmca'];

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
