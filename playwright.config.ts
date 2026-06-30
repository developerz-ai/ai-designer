import { defineConfig } from '@playwright/test';

// E2E loads the built extension unpacked via a persistent context (see test/e2e/fixtures.ts).
// Run `bun run build` first so `.output/chrome-mv3` exists. Runs headless via
// channel:'chromium' (the full Chrome-for-Testing build) — no xvfb needed.
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Persistent-context extension tests don't share browser state cleanly across
  // workers; pin to 1 so the loaded-extension specs stay deterministic.
  workers: 1,
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
