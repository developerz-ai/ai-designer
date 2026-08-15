import { defineConfig } from '@playwright/test';

// E2E loads the built extension unpacked via a persistent context (see test/e2e/fixtures.ts).
// Run `bun run build` first so `build/chrome-mv3` exists. Runs headless via
// channel:'chromium' (the full Chrome-for-Testing build) — no xvfb needed.
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Every spec launches its OWN persistent context against a fresh temp profile
  // (fixtures.ts passes '' as userDataDir), so specs do not actually share browser
  // state — the old `workers: 1` pin cost ~Nx wall-clock for isolation we already had.
  // Each worker is a separate Chromium + unpacked-extension load, which is heavy.
  // Locally default to 2 workers — same rule as vitest.config.ts: an E2E run shares the
  // machine with whatever else is running, and saturating it makes everything stutter.
  // `DZ_E2E_WORKERS` overrides (1 to bisect a suspected cross-spec flake, more for speed).
  // On CI ask for a share of cores rather than a fixed count: the small runners size it.
  workers: Number(process.env.DZ_E2E_WORKERS) || (process.env.CI ? '50%' : 2),
  // CI: `github` emits inline PR annotations; `html` writes playwright-report/
  // (uploaded as an artifact in ci.yml). The github reporter alone produces no
  // report directory, so the artifact upload needs html to have anything to grab.
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  // Headroom for cold Chromium launch + unpacked-extension load + SW registration.
  timeout: 60_000,
  use: {
    trace: 'on-first-retry',
  },
});
