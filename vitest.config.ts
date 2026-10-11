import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Alias workspace packages to their SOURCE so tests run without a prior build (and are
// order-independent in the `pnpm i && pnpm test && pnpm build` gate).
//
// `*.integration.test.ts` need Postgres+Redis and TRUNCATE the database they are pointed at, so
// they are excluded unless MGS_RUN_INTEGRATION_TESTS=1 — which only `pnpm test:integration` sets.
// A bare `vitest run` (or `npx vitest run <dir>`, or naming an integration file) runs none of them.
const runIntegration = process.env.MGS_RUN_INTEGRATION_TESTS === '1';

export default defineConfig({
  resolve: {
    alias: {
      // The subpath first: an alias also matches everything under it.
      '@meegrow-social/contracts/group-status': src('./packages/contracts/src/group-status.ts'),
      '@meegrow-social/contracts/article-markdown': src(
        './packages/contracts/src/article-markdown.ts',
      ),
      '@meegrow-social/contracts': src('./packages/contracts/src/index.ts'),
      '@meegrow-social/core': src('./packages/core/src/index.ts'),
      '@meegrow-social/db': src('./packages/db/src/index.ts'),
      '@meegrow-social/testing': src('./packages/testing/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(runIntegration ? [] : ['**/*.integration.test.ts']),
    ],
    // Integration tests share one Postgres and TRUNCATE in beforeEach — run files serially so
    // one file's reset can't race another's data.
    fileParallelism: false,
  },
});
