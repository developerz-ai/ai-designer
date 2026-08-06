import { existsSync } from 'node:fs';
import path from 'node:path';
import { type BrowserContext, test as base, chromium, type Page } from '@playwright/test';

// Loaded-extension Playwright harness. Chromium only loads an unpacked extension
// through a *persistent context*, and only the `chromium` channel (Chrome-for-Testing)
// runs extensions in the new headless mode — so this works in CI with no xvfb.
// `playwright test` runs from the repo root, so process.cwd() is the repo root.
// (ESM repo — `__dirname` is undefined here.) Requires `bun run build` first.
const pathToExtension = path.resolve(process.cwd(), 'build/chrome-mv3');

/**
 * Stub the endpoint `validateProvider` actually probes for an AUTH verdict. `/models` is not it on
 * OpenRouter — that catalogue is public, so probing it there returns 200 for a config with no key
 * and Settings reported "saved and reachable" for a provider that then 401'd on its first model
 * call. `src/agent/provider.ts` probes `/key` for openrouter.ai hosts; every spec that configures
 * an OpenRouter provider has to stub it alongside `/models` or Save now (correctly) reports the
 * endpoint unreachable.
 */
export async function stubAuthProbe(context: BrowserContext, baseURL: string): Promise<void> {
  await context.route(`${baseURL.replace(/\/+$/, '')}/key`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { label: 'e2e', usage: 0 } }),
    }),
  );
}

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  openExtensionPage: (relativePath: string, opts?: { firstRun?: boolean }) => Promise<Page>;
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
  //
  // The first-run onboarding guide (slice 24) auto-shows on an empty profile as a modal overlay
  // that covers the panel tabs. Every persistent context here starts empty, so by default we seed
  // `onboarding:dismissed=true` (via the SW's chrome.storage) BEFORE navigating, so panel specs
  // reach the tabs unobstructed — exactly as they did before onboarding existed. The dedicated
  // onboarding spec passes `{ firstRun: true }` to see the guide.
  openExtensionPage: async ({ context, extensionId }, use) => {
    await use(async (relativePath: string, opts: { firstRun?: boolean } = {}) => {
      // The seed is load-bearing: without it the first-run modal covers the tab shell and breaks
      // every panel spec. MV3 SWs idle-terminate, so wait for one rather than skip on an empty
      // list — a missing seed must fail loud, not silently no-op into a flaky whole-suite red.
      let [sw] = context.serviceWorkers();
      if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
      await sw.evaluate(async (dismissed) => {
        await chrome.storage.local.set({ 'onboarding:dismissed': dismissed });
      }, !opts.firstRun);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${relativePath.replace(/^\//, '')}`);
      return page;
    });
  },
});

export const expect = test.expect;

/** The five panel surfaces, by their accessible name. */
export type Room = 'Chat' | 'MCP' | 'Settings' | 'Diff' | 'History';

/**
 * Navigate the side panel to a surface.
 *
 * Every spec goes through this instead of clicking a named button directly, so the panel's
 * navigation can change shape without touching 52 call sites. The rows live inside the
 * wordmark's `popover`, which is `display: none` while closed — hence the trigger click first,
 * and hence the `#dz-nav-menu` scope: the room bar's back button is also named "Chat", and an
 * unscoped lookup would be a strict-mode violation with the menu open over a room.
 */
export async function openRoom(p: Page, name: Room): Promise<void> {
  await p.getByRole('button', { name: 'Designer' }).click();
  await p.locator('#dz-nav-menu').getByRole('button', { name }).click();
}
