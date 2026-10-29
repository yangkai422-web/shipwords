import { createFileRoute } from '@tanstack/react-router';
import { core } from '~/core.server';

export const Route = createFileRoute('/api/billing/portal')({
  server: { handlers: { POST: ({ request }) => core.billing.portal(request) } },
});
