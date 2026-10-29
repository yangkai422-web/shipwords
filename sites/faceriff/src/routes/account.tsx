import { pageHead } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { AccountPanel } from '~/site/account';
import site from '../../site.config';

// In-site links open the account dialog; this page is for no-JS visitors and direct links.
export const Route = createFileRoute('/account')({
  head: () =>
    pageHead(site, {
      title: m.common_account_title({ name: site.name }),
      description: m.common_account_description(),
      path: '/account',
      noindex: true,
    }),
  component: () => (
    <section className="account">
      <AccountPanel />
    </section>
  ),
});
