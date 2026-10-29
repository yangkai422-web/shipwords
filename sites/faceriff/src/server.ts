import { Container } from '@cloudflare/containers';
import { proxyRybbit } from '@shipwords/core/analytics';
import { defineGenerationWorkflow } from '@shipwords/jobs/workflow';
import handler from '@tanstack/react-start/server-entry';
import { paraglideMiddleware } from '~/paraglide/server.js';
import site from '../site.config';
import models from '../site.models';

// Worker entry: pages and API go to TanStack Start, plus the Workflow class for generation jobs and the compose container.
export const GenerationWorkflow = defineGenerationWorkflow(models, site);

/** Effect video compose (ffmpeg), image in packages/jobs/compose; one instance per jobId, sleeps after a few idle minutes. */
export class ComposeContainer extends Container {
  override defaultPort = 8080;
  override sleepAfter = '5m';

  // biome-ignore lint/complexity/noBannedTypes: matches the Container base class constructor signature
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // With durable_object scheduling the image and instance type must be passed to start(); @cloudflare/containers 0.3.7 does not, so add them here.
    // Local dev runs no containers (no images), so leave it unchanged.
    const container = ctx.container as
      | (NonNullable<DurableObjectState['container']> & { images?: Record<string, unknown> })
      | undefined;
    if (!container?.images) return;
    const start = container.start.bind(container);
    container.start = (options) =>
      start({ ...options, image: container.images?.compose, instance: 'standard-3' } as never);
  }
}

export default {
  async fetch(request, env) {
    // Rybbit stats go through /stats/ on this site and are forwarded to the collector here.
    const stats = await proxyRybbit(request, env.RYBBIT_UPSTREAM);
    if (stats) return stats;
    // Only local dev picks the locale from a cookie (Chinese review); production is English only and passes requests straight to TanStack Start.
    return import.meta.env.DEV
      ? paraglideMiddleware(request, () => handler.fetch(request))
      : handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
