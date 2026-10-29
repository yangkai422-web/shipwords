import { createFileRoute } from '@tanstack/react-router';
import { core } from '~/core.server';

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => core.handleAuth(request),
      POST: ({ request }) => core.handleAuth(request),
    },
  },
});
