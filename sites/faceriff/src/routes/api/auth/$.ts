import { env } from 'cloudflare:workers';
import { createFileRoute } from '@tanstack/react-router';
import { core } from '~/core.server';
import { safely, stampSignup } from '~/lib/geo';

// After a sign-in that creates an account, record its signup country/language (see lib/geo.ts).
async function auth(request: Request) {
  const response = await core.handleAuth(request);
  await safely(
    () =>
      stampSignup(env.DB, request, response, async (headers) => {
        const session = await core.auth.api.getSession({ headers });
        return session?.user.id ?? null;
      }),
    'signup_geo_failed',
  );
  return response;
}

export const Route = createFileRoute('/api/auth/$')({
  server: { handlers: { GET: ({ request }) => auth(request), POST: ({ request }) => auth(request) } },
});
