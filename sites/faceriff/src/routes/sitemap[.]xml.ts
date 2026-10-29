import { sitemapXml } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import { GUIDES } from '~/site/guide';
import site from '../../site.config';

// Register new indexable pages here.
export const PAGES = ['/', ...GUIDES.map((guide) => guide.path), '/privacy', '/terms', '/refunds', '/dmca'];

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: () =>
        sitemapXml(
          site,
          PAGES.map((path) => ({ path })),
        ),
    },
  },
});
