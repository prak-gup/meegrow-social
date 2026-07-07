import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Alias workspace packages to their SOURCE so tests run without a prior build (and are
// order-independent in the `pnpm i && pnpm test && pnpm build` gate). `*.integration.test.ts`
// require Postgres+Redis and run via `pnpm test:integration` (CI provides service containers).
export default defineConfig({
  resolve: {
    alias: {
      '@meegrow-social/contracts': src('./packages/contracts/src/index.ts'),
      '@meegrow-social/core': src('./packages/core/src/index.ts'),
      '@meegrow-social/db': src('./packages/db/src/index.ts'),
      '@meegrow-social/testing': src('./packages/testing/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Integration tests share one Postgres and TRUNCATE in beforeEach — run files serially so
    // one file's reset can't race another's data.
    fileParallelism: false,
  },
});
