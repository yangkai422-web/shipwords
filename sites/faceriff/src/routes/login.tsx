import { safeRelativePath } from '@shipwords/core/http';
import { pageHead } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { SignInPanel } from '~/site/sign-in';
import site from '../../site.config';

const safeNext = (value: unknown) => safeRelativePath(value, '/');

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === 'string' ? { next: safeNext(search.next) } : {},
  head: () =>
    pageHead(site, {
      title: m.common_login_title({ name: site.name }),
      description: m.common_login_description(),
      path: '/login',
      noindex: true,
    }),
  component: LoginPage,
});

function LoginPage() {
  const next = safeNext(Route.useSearch().next);
  return (
    <section className="login">
      <h1>{m.common_sign_in_submit()}</h1>
      <SignInPanel onDone={() => window.location.assign(next)} />
    </section>
  );
}
