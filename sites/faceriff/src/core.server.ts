import { env as workerEnv } from 'cloudflare:workers';
import { createCore } from '@shipwords/core/server';
import { createJobs } from '@shipwords/jobs/handlers';
import site from '../site.config';
import models from '../site.models';
import { recordPaySuccess } from './lib/conversion-events';

// Server singleton: route files only forward; business logic lives in packages.
export const core = createCore(site, {
  async onPaymentApplied(fact) {
    const db = (workerEnv as unknown as { DB: D1Database }).DB;
    await recordPaySuccess(db, fact);
  },
});
export const jobsApi = createJobs(core, models);
