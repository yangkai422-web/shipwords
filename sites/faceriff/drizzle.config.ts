import { defineConfig } from 'drizzle-kit';

// Migrations are generated from the packages schema plus this site's schema, with timestamp prefixes so parallel work never collides.
// After the packages schema changes, run pnpm db:generate once in each site.
export default defineConfig({
  dialect: 'sqlite',
  schema: [
    '../../packages/core/src/db/schema.ts',
    '../../packages/jobs/src/schema.ts',
    './src/site/schema.ts',
  ],
  out: './migrations',
  migrations: { prefix: 'timestamp' },
});
