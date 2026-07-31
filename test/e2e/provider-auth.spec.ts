import type { BrowserContext } from '@playwright/test';
import { expect, stubAuthProbe, test } from './fixtures';

// E2E: the "Missing Authentication header" regression, against a loaded extension with the real
// key-store, the real readiness push and the real Settings UI.
//
// The setup that broke: an OpenRouter base URL + model saved with NO key. `/models` is public on
// OpenRouter, so the old `/models` probe returned 200, Settings said "saved and reachable", every
// readiness row went green, Start was enabled — and the first model call came back
// `AI_APICallError: Missing Authentication header` from inside the AI SDK stream. Only a loaded
// extension proves the whole chain (panel form → save-provider RPC → key-store → auth probe →
// pushed readiness → the Start button's disabled state).

const BASE_URL = 'https://openrouter.ai/api/v1';

/** OpenRouter's real shape: `/models` is PUBLIC (this is the whole reason the old probe produced
 *  a false green), `/key` is the auth-requiring endpoint we probe instead. Both are stubbed as
 *  reachable — the keyless spec below never reaches either, because `validateProvider` refuses
 *  before issuing a request it knows will 401. (The 401-with-a-bad-key path is covered in
 *  test/unit/provider.test.ts and test/integration/provider-auth-guard.test.ts.) */
async function stubOpenRouter(context: BrowserContext): Promise<void> {
  await context.route(`${BASE_URL}/models`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'test/vision', name: 'Test Vision' }] }),
    }),
  );
  await stubAuthProbe(context, BASE_URL);
}

test('a keyless hosted provider is refused at Save and blocks Start, instead of 401ing mid-turn', async ({
  context,
  openExtensionPage,
}) => {
  await stubOpenRouter(context);
  const page = await openExtensionPage('sidepanel.html');

  await page.getByRole('button', { name: 'Settings' }).click();
  // No key typed at all — the exact setup that used to validate green off the public /models.
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model')).toHaveValue('test/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // Named, actionable, and NOT "saved and reachable".
  const status = page.locator('.dz-settings__status');
  await expect(status).toHaveText(/needs an API key/);
  await expect(status).toHaveClass(/is-bad/);

  // The readiness push says the same thing: the API key row is the one that fails, and Start
  // stays disabled even though provider + model are configured.
  const pill = page.locator('.dz-readiness__pill');
  await expect(pill).toHaveText(/Setup needed/);
  await expect(page.locator('.dz-readiness__toggle')).toBeDisabled();
  await pill.click();
  const apiKeyRow = page.locator('.dz-readiness__row', { hasText: 'API key' });
  await expect(apiKeyRow.locator('.dz-readiness__link')).toHaveText(/Fix/);
});

test('adding the key clears the block — Save goes green and Start enables', async ({
  context,
  openExtensionPage,
}) => {
  await stubOpenRouter(context);
  const page = await openExtensionPage('sidepanel.html');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-key').fill('sk-or-test-auth');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model')).toHaveValue('test/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');
  await expect(page.locator('.dz-readiness__pill')).toHaveText(/Ready/);
  await expect(page.locator('.dz-readiness__toggle')).toBeEnabled();
});

test('a model id the endpoint never listed can be pasted and saved', async ({
  context,
  openExtensionPage,
}) => {
  await stubOpenRouter(context);
  const page = await openExtensionPage('sidepanel.html');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-key').fill('sk-or-test-paste');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model')).toHaveValue('test/vision');

  // The catalogue has one entry and it isn't this one — a `<select>` could not express it at all.
  const model = page.locator('#dz-model');
  await model.fill('minimax/hailuo-3');
  await expect(page.getByText('Use “minimax/hailuo-3”')).toBeVisible();
  await model.press('Enter');
  await expect(model).toHaveValue('minimax/hailuo-3');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');

  // It survives a reload — i.e. it was really persisted, not just held in the input.
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#dz-model')).toHaveValue('minimax/hailuo-3');
});

test('the model list is searchable — typing filters the catalogue', async ({
  context,
  openExtensionPage,
}) => {
  await context.route(`${BASE_URL}/models`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' },
          { id: 'minimax/hailuo-2', name: 'MiniMax Hailuo 2' },
          { id: 'qwen/qwen3.7-flash', name: 'Qwen3.7 Flash' },
        ],
      }),
    }),
  );
  await stubAuthProbe(context, BASE_URL);
  const page = await openExtensionPage('sidepanel.html');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-key').fill('sk-or-test-search');
  await page.getByRole('button', { name: 'Refresh' }).click();

  const model = page.locator('#dz-model');
  await model.fill('hailuo');
  const options = page.locator('.dz-modelcombo__option');
  // The custom "Use …" row plus the one real match — everything else is filtered out.
  await expect(options).toHaveCount(2);
  await expect(page.getByText('MiniMax Hailuo 2')).toBeVisible();
  await expect(page.getByText('GPT-4o mini')).toBeHidden();

  await page.getByText('MiniMax Hailuo 2').click();
  await expect(model).toHaveValue('minimax/hailuo-2');
});
