import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import solid from 'vite-plugin-solid';
import { defineConfig } from 'vitest/config';

const isCI = !!process.env.CI;

// Local worker count: use every core. The previous hard cap of 4 left 8 of 12 cores idle.
// `DZ_TEST_WORKERS` throttles it back when you want the machine responsive
// (e.g. `DZ_TEST_WORKERS=4 bun run test` on battery).
const envWorkers = Number(process.env.DZ_TEST_WORKERS);
const localMax =
  Number.isFinite(envWorkers) && envWorkers > 0 ? envWorkers : availableParallelism();

// Unit + integration share one runner; the npm scripts filter by directory
// (`vitest run unit` / `vitest run integration`) so CI can run them as parallel jobs.
export default defineConfig({
  // Solid compiles JSX to fine-grained reactive calls, not to createElement — without
  // this plugin a mounted component renders nothing and the failure looks like a bug
  // in the component. `ssr: false` keeps the client (DOM) output, which is what jsdom runs.
  plugins: [solid({ ssr: false })],
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
    // (all CPUs). Locally use all but two cores (see localMax above).
    // (Vitest 4 dropped the `minWorkers` option; min stays at its default of 1.)
    maxWorkers: isCI ? undefined : localMax,
    // `.tsx` is included so component specs can MOUNT a Solid component and assert the
    // things that actually matter — roles, accessible names, keyboard reachability,
    // what gets dispatched on click — instead of only exercising pure helpers.
    // Plain-logic specs stay `.ts` and never touch the JSX transform.
    include: ['test/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./test/setup-dom.ts'],
    exclude: ['test/e2e/**', 'node_modules', '.output', '.wxt'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/entrypoints/**', 'src/**/*.d.ts'],
    },
  },
});
