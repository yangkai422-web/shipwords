import { createFileRoute } from '@tanstack/react-router';
import { jobsApi } from '~/core.server';

export const Route = createFileRoute('/api/jobs/$id')({
  server: { handlers: { GET: ({ request, params }) => jobsApi.get(request, params.id) } },
});
