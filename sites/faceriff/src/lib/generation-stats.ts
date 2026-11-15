import { createServerFn } from '@tanstack/react-start';
import { getSucceededGenerationCount } from '~/lib/generation-count';

/** Homepage loader: cached count of successful renders. */
export const getGenerationCount = createServerFn({ method: 'GET' }).handler(async () => {
  const { core } = await import('~/core.server');
  const db = (core.env as { DB: Parameters<typeof getSucceededGenerationCount>[0] }).DB;
  return getSucceededGenerationCount(db);
});
