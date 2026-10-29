import { createFileRoute } from '@tanstack/react-router';
import { core } from '~/core.server';

// Set the Stripe webhook URL to https://<domain>/api/webhooks/stripe; the event list is in docs/site-launch.md.
export const Route = createFileRoute('/api/webhooks/stripe')({
  server: { handlers: { POST: ({ request }) => core.billing.webhook(request) } },
});
