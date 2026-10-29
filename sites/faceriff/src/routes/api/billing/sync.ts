import { createFileRoute } from '@tanstack/react-router';
import { core } from '~/core.server';

export const Route = createFileRoute('/api/billing/sync')({
  server: { handlers: { POST: ({ request }) => core.billing.sync(request) } },
});
