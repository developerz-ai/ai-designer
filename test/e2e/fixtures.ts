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
    const context = await chromium.launchPersistentContext('', {
      // Headed Chromium loads an unpacked MV3 extension and *starts* its service
      // worker reliably. New-headless (channel:'chromium') failed to register the
      // SW on the CI runner, so CI runs this headed under xvfb (see ci.yml).
      // --no-sandbox is required on CI runners or the headed launch hangs.
      headless: false,
      timeout: 60_000,
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
