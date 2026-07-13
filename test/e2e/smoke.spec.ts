import { expect, test } from './fixtures';

// E2E smoke — loads the built extension (.output/chrome-mv3) and asserts the side
// panel mounts. MV3 side panels can't be opened via a Playwright toolbar gesture,
// so navigate a tab directly to the panel's extension-origin page and assert the
// Chat surface renders. WXT flattens the entrypoint to `sidepanel.html` at the
// output root (the source path is `sidepanel/index.html`).
test('side panel mounts and shows the Chat surface', async ({ openExtensionPage }) => {
  const page = await openExtensionPage('sidepanel.html');

  // App shell rendered (App.tsx → <div class="dz-app">).
  await expect(page.locator('.dz-app')).toBeVisible({ timeout: 10_000 });

  // Default tab is Chat → ChatPanel rendered. Static DOM, no chrome.* / network
  // dependency at mount, so this is deterministic across CI retries.
  await expect(page.getByRole('button', { name: 'Chat' })).toBeVisible();
  await expect(page.getByPlaceholder('Tell the agent what to change…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
});

// CSP no-remote-fetch verification: icons are self-hosted, tree-shaken SVG (bundled JS,
// not a remote webfont — CLAUDE.md "no remote code" MV3 rule / "Icon component (inline
// SVG, tree-shaken, no innerHTML-of-remote)"). Every request the loaded panel makes must
// resolve to its own extension origin and none may be blocked (e.g. by CSP) or fail.
test('side panel makes zero blocked/remote font or script requests', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  const requestUrls: string[] = [];
  const failedRequests: string[] = [];

  page.on('request', (request) => {
    requestUrls.push(request.url());
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? 'unknown'})`);
  });

  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.locator('.dz-app')).toBeVisible({ timeout: 10_000 });

  const remoteRequests = requestUrls.filter((url) => !url.startsWith('chrome-extension://'));
  expect(remoteRequests).toEqual([]);
  expect(failedRequests).toEqual([]);

  await page.close();
});
