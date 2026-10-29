import { createFileRoute } from '@tanstack/react-router';
import { addToHandoff, readHandoff } from '~/site/handoff.server';

export const Route = createFileRoute('/api/handoff/$token')({
  server: {
    handlers: {
      GET: ({ params }) => readHandoff(params.token),
      POST: ({ request, params }) => addToHandoff(request, params.token),
    },
  },
});
