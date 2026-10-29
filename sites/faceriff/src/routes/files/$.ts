import { createFileRoute } from '@tanstack/react-router';
import { jobsApi } from '~/core.server';

export const Route = createFileRoute('/files/$')({
  server: { handlers: { GET: ({ request, params }) => jobsApi.file(request, params._splat ?? '') } },
});
