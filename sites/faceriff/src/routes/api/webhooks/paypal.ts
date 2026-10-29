import { createFileRoute } from '@tanstack/react-router';
import { core } from '~/core.server';

// When site.config.ts picks PayPal, set the webhook URL in the PayPal developer dashboard to https://<domain>/api/webhooks/paypal;
// the event list is in docs/site-launch.md.
export const Route = createFileRoute('/api/webhooks/paypal')({
  server: { handlers: { POST: ({ request }) => core.billing.webhook(request) } },
});
