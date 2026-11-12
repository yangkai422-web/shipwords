import { env } from 'cloudflare:workers';
import { createFileRoute } from '@tanstack/react-router';
import { core } from '~/core.server';
import { safely, stampPaid } from '~/lib/geo';

export const Route = createFileRoute('/api/billing/sync')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const response = await core.billing.sync(request);
        await safely(() => stampPaid(env.DB, request, response), 'payment_geo_failed');
        return response;
      },
    },
  },
});
