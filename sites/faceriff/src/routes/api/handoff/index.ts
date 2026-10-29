import { createFileRoute } from '@tanstack/react-router';
import { createHandoff } from '~/site/handoff.server';

export const Route = createFileRoute('/api/handoff/')({
  server: { handlers: { POST: () => createHandoff() } },
});
