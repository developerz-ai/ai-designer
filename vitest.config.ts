import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const isCI = !!process.env.CI;
const localMax = Math.min(4, availableParallelism());

// Unit + integration share one runner; the npm scripts filter by directory
// (`vitest run unit` / `vitest run integration`) so CI can run them as parallel jobs.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      // The WXT-generated #i18n module resolves via globalThis chrome/browser, which the
      // per-test fakes replace. Point tests at a self-contained double that reads
      // src/locales/en.yml directly, so localized strings resolve independent of the fake.
      '#i18n': resolve(__dirname, './test/fakes/i18n.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // On CI leave workers uncapped — Vitest defaults to available parallelism
    // (all CPUs). Locally cap at 4 to keep dev machines responsive.
    // (Vitest 4 dropped the `minWorkers` option; min stays at its default of 1.)
    maxWorkers: isCI ? undefined : localMax,
    include: ['test/**/*.{test,spec}.ts'],
    exclude: ['test/e2e/**', 'node_modules', '.output', '.wxt'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/entrypoints/**', 'src/**/*.d.ts'],
    },
  },
});
