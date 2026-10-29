import { createFileRoute } from '@tanstack/react-router';
import { core } from '~/core.server';

export const Route = createFileRoute('/api/billing/me')({
  server: { handlers: { GET: ({ request }) => core.billing.me(request) } },
});
