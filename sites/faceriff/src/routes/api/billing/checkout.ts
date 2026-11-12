import { env } from 'cloudflare:workers';
import { createFileRoute } from '@tanstack/react-router';
import { core } from '~/core.server';
import { safely, stampCheckout } from '~/lib/geo';

export const Route = createFileRoute('/api/billing/checkout')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const response = await core.billing.checkout(request);
        await safely(() => stampCheckout(env.DB, request, response), 'order_geo_failed');
        return response;
      },
    },
  },
});
