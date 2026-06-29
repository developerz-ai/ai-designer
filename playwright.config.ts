import { defineConfig } from '@playwright/test';

// E2E loads the built extension unpacked via a persistent context (see test/e2e/fixtures.ts).
// Run `bun run build` first so `.output/chrome-mv3` exists. The extension is loaded with
// channel:'chromium' (new headless) — no xvfb needed.
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Persistent-context extension tests don't share browser state cleanly across
  // workers; pin to 1 so the loaded-extension specs stay deterministic.
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  use: {
    trace: 'on-first-retry',
  },
});
