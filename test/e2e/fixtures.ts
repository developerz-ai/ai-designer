import { existsSync } from 'node:fs';
import path from 'node:path';
import { type BrowserContext, test as base, chromium, type Page } from '@playwright/test';

// Loaded-extension Playwright harness. Chromium only loads an unpacked extension
// through a *persistent context*, and only the `chromium` channel (Chrome-for-Testing)
// runs extensions in the new headless mode — so this works in CI with no xvfb.
// `playwright test` runs from the repo root, so process.cwd() is the repo root.
// (ESM repo — `__dirname` is undefined here.) Requires `bun run build` first.
const pathToExtension = path.resolve(process.cwd(), '.output/chrome-mv3');

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  openExtensionPage: (relativePath: string) => Promise<Page>;
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright passes the fixtures object as arg 1; this fixture has no deps.
  context: async ({}, use) => {
    // Fail fast with a clear message instead of a confusing 30s service-worker
    // timeout when the build hasn't run yet.
    if (!existsSync(pathToExtension)) {
      throw new Error(
        `Built extension not found at ${pathToExtension} — run \`bun run build\` first.`,
      );
    }

    const context = await chromium.launchPersistentContext('', {
      // channel:'chromium' = the full Chrome-for-Testing build, which loads an
      // unpacked extension in new headless (the lightweight chrome-headless-shell
      // does not). --no-sandbox is required on CI runners.
      channel: 'chromium',
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
      ],
    });
    await use(context);
    await context.close();
  },

  // MV3 extension id = host of the service-worker URL (chrome-extension://<id>/background.js).
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    await use(new URL(sw.url()).host);
  },

  // Open any extension-origin page in this context (side panels can't be opened
  // via a Playwright toolbar gesture, so we navigate a tab to the panel page).
  openExtensionPage: async ({ context, extensionId }, use) => {
    await use(async (relativePath: string) => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${relativePath.replace(/^\//, '')}`);
      return page;
    });
  },
});

export const expect = test.expect;
