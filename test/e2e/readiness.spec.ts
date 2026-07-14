import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';

// E2E: the header readiness pill + Start/Stop gate (slice 03), end to end against a
// loaded, fresh-profile build — no stubbed chrome.* here, unlike the unit/integration
// truth-table tests (test/unit/readiness.test.ts, test/integration/readiness.test.ts),
// which drive src/agent/readiness.ts directly against fake chrome.storage/permissions.
// This spec instead walks the real panel: fresh profile -> "Setup needed" + Start
// disabled -> configure a provider (stubbed /models, mirrors settings.spec.ts) -> pill
// flips to Ready -> Start -> ChatPanel replaces the pre-Start empty state.

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

test('fresh profile: Setup needed + Start disabled -> configure -> Ready -> Start -> chat visible', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context, 'https://openrouter.ai/api/v1', [
    { id: 'test/vision', name: 'Test Vision' },
  ]);
  const page = await openExtensionPage('sidepanel.html');

  // Fresh profile: no provider configured yet -> pill reads "Setup needed", Start
  // disabled (App.tsx gates ChatPanel behind session state, which never left `idle`).
  const pill = page.locator('.dz-readiness__pill');
  const toggle = page.locator('.dz-readiness__toggle');
  await expect(pill).toHaveText(/Setup needed/);
  await expect(toggle).toHaveText('Start');
  await expect(toggle).toBeDisabled();
  await expect(
    page.getByText('Configure a provider above, then hit Start to begin chatting.'),
  ).toBeVisible();

  // Expand the pill and confirm the per-check rows all read not-ok before anything's set.
  // Five rows total: the four readiness checks plus the "On-page overlay" toggle (slice 09).
  // Only the four not-ok checks expose a "Fix" deep-link — the overlay toggle does not.
  await pill.click();
  const rows = page.locator('.dz-readiness__row');
  await expect(rows).toHaveCount(5);
  await expect(page.locator('.dz-readiness__link', { hasText: 'Fix' })).toHaveCount(4);
  await pill.click(); // collapse again

  // Configure a provider (OpenRouter preset — already host-permitted via the manifest,
  // so no runtime permission prompt) the same way settings.spec.ts does.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-key').fill('sk-or-test-readiness');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model option')).toHaveText(['Test Vision']);
  await page.locator('#dz-model').selectOption('test/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');

  // save-provider's pushReadiness fan-out flips the header pill live, no reload needed.
  await expect(pill).toHaveText(/Ready/);
  await expect(toggle).toBeEnabled();

  // Start flips the session out of `idle`; the pill swaps to "Running…" and the
  // pre-Start empty state is replaced by the real ChatPanel.
  await toggle.click();
  await expect(pill).toHaveText(/Running…/);
  await expect(toggle).toHaveText('Stop');

  await page.getByRole('button', { name: 'Chat' }).click();
  await expect(page.getByPlaceholder('Tell the agent what to change…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
});
