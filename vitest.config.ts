import { resolve } from 'node:path';
import solid from 'vite-plugin-solid';
import { defineConfig } from 'vitest/config';

const isCI = !!process.env.CI;

// Local worker count: 2. Dev-machine test runs share the box with whatever else is running,
// and a fully saturated run (one worker per core + a jsdom per worker) made everything else
// stutter AND produced phantom failures — specs that finish in <1s alone tripped the 5s
// testTimeout purely from CPU contention. `DZ_TEST_WORKERS` still wins in either direction
// (e.g. `DZ_TEST_WORKERS=8 bun run test` for a quick full-speed pass); CI stays uncapped.
const envWorkers = Number(process.env.DZ_TEST_WORKERS);
const localMax = Number.isFinite(envWorkers) && envWorkers > 0 ? envWorkers : 2;

// Unit + integration share one runner; the npm scripts filter by directory
// (`vitest run unit` / `vitest run integration`) so CI can run them as parallel jobs.
export default defineConfig({
  // Solid compiles JSX to fine-grained reactive calls, not to createElement — without
  // this plugin a mounted component renders nothing and the failure looks like a bug
  // in the component. `ssr: false` keeps the client (DOM) output, which is what jsdom runs.
  // `hot: false` because Vitest runs Vite in `serve` mode, so the plugin would inject the
  // solid-refresh HMR runtime into every `.tsx` spec. Its virtual id `/@solid-refresh` then
  // reaches `fileURLToPath('file:///@solid-refresh')`, which is a valid POSIX path but NOT a
  // valid Windows one — so all 24 component specs die on Windows with "argument 'filename'
  // must be … an absolute path string". Tests never hot-reload; the runtime is pure overhead.
  plugins: [solid({ ssr: false, hot: false })],
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
    // Both entries exist for the same reason: on a dev box without Node, everything here runs
    // under Bun, and EXTERNALIZED deps are then native-imported by Bun instead of evaluated by
    // Vite — with two distinct failure modes. `inline` is checked before `external`
    // (vitest _shouldExternalize), so this list wins over any plugin-injected `external`.
    //
    // zod — Bun exposes `__esModule` on every ESM namespace, so vitest's interopModule()
    // mistakes zod's `default` export (the re-exported `z` namespace) for transpiled CJS and
    // swaps the real namespace for it — `import { z } from 'zod'` arrives undefined and every
    // schema module dies at import time.
    //
    // solid — vite-plugin-solid marks /solid-js/ as `server.deps.external` in test mode, so
    // @solidjs/testing-library and solid's own builds load through the runtime resolver. Under
    // plain `bunx vitest` Bun resolves solid's browser/dev builds and it happens to work; but
    // `bun run test:*` executes the vitest bin through Bun's temporary `node.exe` masquerade
    // shim (created because no real Node exists), and Bun-as-node switches to Node-style
    // export conditions — externalized solid resolves to dist/server.* while the vite-processed
    // app code gets the client build. Two solid instances, one server-side: every mount dies
    // with "Client-only API called on the server side" / `DEV.registerGraph` undefined.
    // Inlining the whole solid family keeps ONE vite-resolved (browser, dev) copy everywhere.
    // No-op difference under real Node on CI beyond a little transform time.
    server: {
      deps: {
        inline: ['zod', /\/node_modules\/solid-js\//, '@solidjs/testing-library'],
      },
    },
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
    exclude: ['test/e2e/**', 'node_modules', 'build', '.wxt'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/entrypoints/**', 'src/**/*.d.ts'],
    },
  },
});
