import { createFileRoute } from '@tanstack/react-router';
import { jobsApi } from '~/core.server';

export const Route = createFileRoute('/api/uploads')({
  server: { handlers: { POST: ({ request }) => jobsApi.upload(request) } },
});
