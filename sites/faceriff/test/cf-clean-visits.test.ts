import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLEAN_VISIT_AND_FILTERS,
  CLEAN_VISITS_QUERY,
  cleanVisitGroupFilter,
  cleanVisitVariables,
  isUsableAnalyticsToken,
  loadCleanVisitWindow,
  mapCleanVisitResponse,
  maybeRefreshCleanVisits,
  refreshCleanVisits,
  type CleanVisitFetcher,
} from '../src/lib/cf-clean-visits';

const now = Date.parse('2026-11-13T05:15:00Z');
const token = 'cf-analytics-read-test-token-value-xxxxxxxxxxxx';
const sql = (s: string, ...p: (string | number | null)[]) =>
  env.DB.prepare(s)
    .bind(...p)
    .run();

const graphqlBody = {
  data: {
    viewer: {
      zones: [
        {
          totals: [{ sum: { visits: 203, edgeResponseBytes: 9000 }, count: 775 }],
          byDate: [
            {
              dimensions: { date: '2026-11-12' },
              sum: { visits: 100, edgeResponseBytes: 4000 },
              count: 400,
            },
            {
              dimensions: { date: '2026-11-13' },
              sum: { visits: 103, edgeResponseBytes: 5000 },
              count: 375,
            },
          ],
        },
      ],
    },
  },
};

const fetcher: CleanVisitFetcher = async () => graphqlBody;

beforeEach(async () => {
  await sql('DELETE FROM cf_clean_visits');
  await sql('DELETE FROM cf_clean_visit_window');
});

describe('clean-visit query shape', () => {
  it('rejects missing or short tokens and never treats whitespace as usable', () => {
    expect(isUsableAnalyticsToken(undefined)).toBe(false);
    expect(isUsableAnalyticsToken('')).toBe(false);
    expect(isUsableAnalyticsToken('   ')).toBe(false);
    expect(isUsableAnalyticsToken('short-token')).toBe(false);
    expect(isUsableAnalyticsToken(token)).toBe(true);
  });

  it('builds the bookmark filters without putting zoneTag inside the groups filter', () => {
    const filter = cleanVisitGroupFilter('2026-11-12T05:15:00.000Z', '2026-11-13T05:15:00.000Z');
    expect(filter).toEqual({
      datetime_geq: '2026-11-12T05:15:00.000Z',
      datetime_lt: '2026-11-13T05:15:00.000Z',
      AND: [
        { clientRequestPath_notlike: '%/api/admin%' },
        { clientRequestPath_notlike: '%/sitemap.xml%' },
        { clientRequestPath_notlike: '%/robots.txt%' },
        { userAgentBrowser_neq: 'Curl' },
        { userAgentBrowser_neq: 'ChromeHeadless' },
      ],
    });
    expect(filter).not.toHaveProperty('zoneTag');
    expect(JSON.stringify(filter.AND)).toBe(JSON.stringify(CLEAN_VISIT_AND_FILTERS));
  });

  it('uses sum.visits and count, not sum.requests, and keeps window vs daily filters separate', () => {
    expect(CLEAN_VISITS_QUERY).toContain('sum { visits edgeResponseBytes }');
    expect(CLEAN_VISITS_QUERY).toContain('count');
    expect(CLEAN_VISITS_QUERY).not.toContain('sum.requests');
    expect(CLEAN_VISITS_QUERY).not.toMatch(/sum\s*\{\s*[^}]*requests/);
    expect(CLEAN_VISITS_QUERY).toContain('$windowFilter');
    expect(CLEAN_VISITS_QUERY).toContain('$dailyFilter');
    const variables = cleanVisitVariables('b24ec5ba31b1af31ad3afc70ae48e3f6', now);
    expect(variables.zone).toBe('b24ec5ba31b1af31ad3afc70ae48e3f6');
    expect(variables.windowFilter.datetime_geq).toBe('2026-11-12T05:15:00.000Z');
    expect(variables.windowFilter.datetime_lt).toBe('2026-11-13T05:15:00.000Z');
    expect(variables.dailyFilter.datetime_geq).toBe('2026-10-15T00:00:00.000Z');
    expect(Date.parse(variables.dailyFilter.datetime_lt) - Date.parse(variables.dailyFilter.datetime_geq)).toBeLessThanOrEqual(30 * 86_400_000);
    expect(variables.dailyFilter.AND).toEqual(variables.windowFilter.AND);
  });

  it('maps GraphQL totals and UTC daily rows', () => {
    const snap = mapCleanVisitResponse(graphqlBody, now - 86_400_000, now);
    expect(snap).toMatchObject({ visits: 203, requests: 775, bytes: 9000, windowStart: now - 86_400_000 });
    expect(snap.days).toEqual([
      { dayUtc: '2026-11-12', visits: 100, requests: 400, bytes: 4000 },
      { dayUtc: '2026-11-13', visits: 103, requests: 375, bytes: 5000 },
    ]);
  });
});

describe('clean-visit refresh', () => {
  it('stores the rolling window and UTC daily rows, marking today partial', async () => {
    const seen: unknown[] = [];
    const capturing: CleanVisitFetcher = async (input) => {
      seen.push({
        zone: input.zone,
        query: input.query,
        hasToken: typeof input.token === 'string' && input.token.length >= 32,
        and: input.variables.windowFilter.AND,
        zoneInFilter: 'zoneTag' in input.variables.windowFilter,
      });
      return graphqlBody;
    };
    expect(
      await refreshCleanVisits(
        { DB: env.DB, CF_ANALYTICS_TOKEN: token, CF_ZONE_TAG: 'b24ec5ba31b1af31ad3afc70ae48e3f6' },
        { now, maxAge: 0, fetcher: capturing },
      ),
    ).toBeNull();
    expect(seen[0]).toMatchObject({
      zone: 'b24ec5ba31b1af31ad3afc70ae48e3f6',
      query: CLEAN_VISITS_QUERY,
      hasToken: true,
      zoneInFilter: false,
      and: CLEAN_VISIT_AND_FILTERS,
    });
    expect(await loadCleanVisitWindow(env.DB)).toMatchObject({
      visits: 203,
      requests: 775,
      bytes: 9000,
      windowStart: now - 86_400_000,
      windowEnd: now,
      fetchedAt: now,
      lastError: null,
    });
    const days = await env.DB.prepare(
      'SELECT day_utc day,visits,requests,is_partial partial FROM cf_clean_visits ORDER BY day_utc',
    ).all<{ day: string; visits: number; requests: number; partial: number }>();
    expect(days.results).toEqual([
      { day: '2026-11-12', visits: 100, requests: 400, partial: 0 },
      { day: '2026-11-13', visits: 103, requests: 375, partial: 1 },
    ]);
  });

  it('skips the network when the token is missing or short and keeps the last snapshot', async () => {
    await refreshCleanVisits(
      { DB: env.DB, CF_ANALYTICS_TOKEN: token },
      { now, maxAge: 0, fetcher },
    );
    const spy = vi.fn(fetcher);
    expect(
      await refreshCleanVisits({ DB: env.DB }, { now: now + 20 * 60_000, maxAge: 0, fetcher: spy }),
    ).toBe('not_configured');
    expect(
      await refreshCleanVisits(
        { DB: env.DB, CF_ANALYTICS_TOKEN: 'too-short' },
        { now: now + 20 * 60_000, maxAge: 0, fetcher: spy },
      ),
    ).toBe('token_invalid');
    expect(spy).not.toHaveBeenCalled();
    expect(await loadCleanVisitWindow(env.DB)).toMatchObject({
      visits: 203,
      requests: 775,
      fetchedAt: now,
      lastError: 'token_invalid',
    });
  });

  it('keeps the last snapshot when Cloudflare errors or times out', async () => {
    await refreshCleanVisits(
      { DB: env.DB, CF_ANALYTICS_TOKEN: token },
      { now, maxAge: 0, fetcher },
    );
    const boom: CleanVisitFetcher = async () => {
      throw new Error('graphql_http_403');
    };
    expect(
      await refreshCleanVisits(
        { DB: env.DB, CF_ANALYTICS_TOKEN: token },
        { now: now + 20 * 60_000, maxAge: 0, fetcher: boom },
      ),
    ).toBe('graphql_http_403');
    expect(await loadCleanVisitWindow(env.DB)).toMatchObject({
      visits: 203,
      requests: 775,
      fetchedAt: now,
      lastError: 'graphql_http_403',
      lastAttemptAt: now + 20 * 60_000,
    });
    const timed: CleanVisitFetcher = async () => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      throw error;
    };
    expect(
      await refreshCleanVisits(
        { DB: env.DB, CF_ANALYTICS_TOKEN: token },
        { now: now + 21 * 60_000, maxAge: 0, fetcher: timed },
      ),
    ).toBe('timeout');
    expect(await loadCleanVisitWindow(env.DB)).toMatchObject({ visits: 203, lastError: 'timeout' });
  });

  it('does not refetch a fresh snapshot', async () => {
    await refreshCleanVisits(
      { DB: env.DB, CF_ANALYTICS_TOKEN: token },
      { now, maxAge: 0, fetcher },
    );
    const spy = vi.fn(fetcher);
    expect(
      await refreshCleanVisits(
        { DB: env.DB, CF_ANALYTICS_TOKEN: token },
        { now: now + 60_000, maxAge: 15 * 60_000, fetcher: spy },
      ),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('refreshes in the background when a snapshot already exists, and waits when it does not', async () => {
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const slow: CleanVisitFetcher = async () => {
      await pending;
      return graphqlBody;
    };
    let background: Promise<unknown> | undefined;
    const waiting = maybeRefreshCleanVisits(
      { DB: env.DB, CF_ANALYTICS_TOKEN: token },
      { now, maxAge: 0, fetcher: slow },
    );
    const firstDone = await Promise.race([
      waiting.then(() => 'waited'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 30)),
    ]);
    expect(firstDone).toBe('blocked');
    release(graphqlBody);
    expect(await waiting).toBeNull();
    expect(await loadCleanVisitWindow(env.DB)).toMatchObject({ visits: 203, fetchedAt: now });

    const later = new Promise((resolve) => {
      release = resolve;
    });
    const laterFetcher: CleanVisitFetcher = async () => {
      await later;
      return {
        data: {
          viewer: {
            zones: [{ totals: [{ sum: { visits: 210, edgeResponseBytes: 1 }, count: 800 }], byDate: [] }],
          },
        },
      };
    };
    const backgrounded = maybeRefreshCleanVisits(
      { DB: env.DB, CF_ANALYTICS_TOKEN: token },
      {
        now: now + 20 * 60_000,
        maxAge: 15 * 60_000,
        fetcher: laterFetcher,
        waitUntil: (promise) => {
          background = promise;
        },
      },
    );
    await vi.waitFor(() => expect(background).toBeDefined());
    expect(await backgrounded).toBeNull();
    expect(await loadCleanVisitWindow(env.DB)).toMatchObject({ visits: 203, fetchedAt: now });
    release(true);
    await background;
    expect(await loadCleanVisitWindow(env.DB)).toMatchObject({
      visits: 210,
      requests: 800,
      fetchedAt: now + 20 * 60_000,
    });
  });
});
