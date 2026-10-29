import { createCore } from '@shipwords/core/server';
import { createJobs } from '@shipwords/jobs/handlers';
import site from '../site.config';
import models from '../site.models';

// Server singleton: route files only forward; business logic lives in packages.
export const core = createCore(site);
export const jobsApi = createJobs(core, models);
