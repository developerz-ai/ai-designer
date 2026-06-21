import { defineConfig } from '@playwright/test';

// E2E loads the built extension unpacked and drives a fixture page.
// Run `bun run build` first so `.output/chrome-mv3` exists.
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'on-first-retry',
  },
});
