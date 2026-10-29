import { createSiteAuthClient, type SiteAuthClient } from '@shipwords/core/react/auth-client';

let client: SiteAuthClient | null = null;

/** Browser auth client, created from the public config on first call. */
export function authClient(googleClientId: string | null): SiteAuthClient {
  client ??= createSiteAuthClient({ googleClientId });
  return client;
}
