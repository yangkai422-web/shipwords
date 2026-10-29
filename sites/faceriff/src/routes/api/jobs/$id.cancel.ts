import { createFileRoute } from '@tanstack/react-router';
import { jobsApi } from '~/core.server';

export const Route = createFileRoute('/api/jobs/$id/cancel')({
  server: { handlers: { POST: ({ request, params }) => jobsApi.cancel(request, params.id) } },
});
