import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';

// Stub OpenRouter so the BYOK flow validates + lists models without a real key or
// network egress. These fetches originate in the extension service worker; routing
// on the context intercepts them.
async function stubOpenRouter(context: BrowserContext): Promise<void> {
  await context.route('**/api/v1/key', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { label: 'test-key' } }),
    }),
  );
  await context.route('**/api/v1/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'test/vision', name: 'Test Vision' }] }),
    }),
  );
}

test('BYOK key validates, lists models, and persists (decrypts) across reload', async ({
  context,
  openExtensionPage,
}) => {
  await stubOpenRouter(context);
  const page = await openExtensionPage('sidepanel.html');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-or-key').fill('sk-or-test-123');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // Validated SW-side and the model list populated from the (stubbed) endpoint.
  await expect(page.locator('.dz-settings__status')).toHaveText('Key valid.');
  await expect(page.locator('#dz-or-model option')).toHaveText(['Test Vision']);

  // Reload: key-status reports present and list-models succeeds again — which only
  // works if the persisted ciphertext decrypted SW-side with the IndexedDB key.
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#dz-or-key')).toHaveAttribute('placeholder', /saved/);
  await expect(page.locator('.dz-settings__status')).toHaveText('Key valid.');
  await expect(page.locator('#dz-or-model option')).toHaveText(['Test Vision']);
});
