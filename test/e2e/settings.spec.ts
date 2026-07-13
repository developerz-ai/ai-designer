import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';

// Stub the openai-compatible /models endpoint the extension's service worker calls
// directly for BYOK validate + list-models (src/agent/provider.ts: raw SW-side fetch, no
// SDK network mocking possible). Routing on the persistent context intercepts it so these
// specs need no real key and make no real network egress.
async function stubModels(
  context: BrowserContext,
  baseURL: string,
  models: Array<{ id: string; name: string }>,
): Promise<void> {
  await context.route(`${baseURL.replace(/\/+$/, '')}/models`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: models }),
    }),
  );
}

test('OpenRouter preset: BYOK key validates, lists models, and persists (decrypts) across reload', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context, 'https://openrouter.ai/api/v1', [
    { id: 'test/vision', name: 'Test Vision' },
  ]);
  const page = await openExtensionPage('sidepanel.html');

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#dz-preset')).toHaveValue('openrouter'); // default preset

  await page.locator('#dz-key').fill('sk-or-test-123');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model option')).toHaveText(['Test Vision']);

  await page.locator('#dz-model').selectOption('test/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');

  // Reload: key-status reports present and list-models succeeds again — which only
  // works if the persisted ciphertext decrypted SW-side with the IndexedDB wrapping key.
  // Reload resets the ephemeral save-status; hasKey (loaded from the SW) drives the
  // idle-state status text instead — see stores/settings.ts statusText().
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#dz-key')).toHaveAttribute('placeholder', /saved/);
  await expect(page.locator('.dz-settings__status')).toHaveText('Key saved.');
  await expect(page.locator('#dz-model option')).toHaveText(['Test Vision']);
});

// A not-yet-granted custom host needs a real chrome.permissions.request prompt, driven by
// a live user gesture (see src/shared/host-permissions.ts — a click in the panel is a real
// gesture, but chrome.runtime.sendMessage to the SW does NOT carry it across, so the panel
// requests the grant itself before the save-provider RPC). No current Playwright/CDP API
// can drive that native prompt to a decision in a headless harness — confirmed empirically
// against a loaded build, the request() promise never settles, gesture or not. That
// grant/deny/reject branch is instead covered deterministically by
// test/unit/host-permissions.test.ts (ensureHostAccess) and
// test/unit/settings-store.test.ts (the panel-side call inside saveProvider).
//
// This spec exercises everything else about a custom endpoint end to end — the preset
// dropdown, free-text base URL input, BYOK key, model refresh, save, and reload
// persistence — against a URL on openrouter.ai's origin (the one host already granted via
// the manifest's static host_permissions) so the save completes without a permission
// prompt, while a distinct path keeps it recognized as "Custom" rather than the preset.
test('Custom base URL: validate -> list models -> persist across reload', async ({
  context,
  openExtensionPage,
}) => {
  const base = 'https://openrouter.ai/api/v1/custom-test';
  await stubModels(context, base, [{ id: 'custom/vision', name: 'Custom Vision' }]);
  const page = await openExtensionPage('sidepanel.html');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-preset').selectOption('custom');
  await page.locator('.dz-settings__url').fill(base);
  await page.locator('#dz-key').fill('sk-custom-test-456');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model option')).toHaveText(['Custom Vision']);

  await page.locator('#dz-model').selectOption('custom/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');

  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#dz-preset')).toHaveValue('custom');
  await expect(page.locator('.dz-settings__url')).toHaveValue(base);
  await expect(page.locator('#dz-key')).toHaveAttribute('placeholder', /saved/);
  await expect(page.locator('.dz-settings__status')).toHaveText('Key saved.');
  await expect(page.locator('#dz-model option')).toHaveText(['Custom Vision']);
});
