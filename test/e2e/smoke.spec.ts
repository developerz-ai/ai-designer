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
