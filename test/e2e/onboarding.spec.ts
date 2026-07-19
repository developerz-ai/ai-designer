import { expect, test } from './fixtures';

// E2E — the first-run onboarding guide (slice 24). On an empty profile the guide auto-shows as a
// modal overlay (`data-testid="first-run-onboarding"`); every other panel spec suppresses it via
// the fixture's default seed, so this spec opts back in with `{ firstRun: true }` to exercise it.
// Covers the issue's acceptance: guides setup (3 steps), skippable + persisted, links privacy, and
// re-entrant from Settings.

test('first run shows the 3-step guide with a privacy link; Skip dismisses it for good', async ({
  openExtensionPage,
}) => {
  const panel = await openExtensionPage('sidepanel.html', { firstRun: true });

  const guide = panel.getByTestId('first-run-onboarding');
  await expect(guide).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByRole('heading', { name: 'Welcome to Designer' })).toBeVisible();

  // The three guided steps + the privacy link (acceptance: "Links to docs / privacy policy").
  await expect(guide.getByText('Add your AI provider')).toBeVisible();
  await expect(guide.getByText('Connect a backend')).toBeVisible();
  await expect(guide.getByText('Make your first edit')).toBeVisible();
  await expect(guide.getByRole('link', { name: 'Privacy policy' })).toBeVisible();

  // Skippable — and the dismissal persists across a panel reload (SW-backed flag).
  await panel.getByRole('button', { name: 'Skip for now' }).click();
  await expect(guide).toBeHidden();

  await panel.reload();
  await expect(panel.locator('.dz-app')).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByTestId('first-run-onboarding')).toHaveCount(0);
});

test('a step CTA hides the guide and deep-links to the tab that fixes it', async ({
  openExtensionPage,
}) => {
  const panel = await openExtensionPage('sidepanel.html', { firstRun: true });
  await expect(panel.getByTestId('first-run-onboarding')).toBeVisible({ timeout: 10_000 });

  // "Open settings" on the provider step closes the overlay and switches to the Settings tab.
  await panel.getByRole('button', { name: 'Open settings' }).click();
  await expect(panel.getByTestId('first-run-onboarding')).toHaveCount(0);
  await expect(panel.locator('#dz-preset')).toBeVisible();
});

test('the guide is re-entrant from Settings after being dismissed', async ({
  openExtensionPage,
}) => {
  const panel = await openExtensionPage('sidepanel.html', { firstRun: true });
  await panel.getByRole('button', { name: 'Skip for now' }).click();
  await expect(panel.getByTestId('first-run-onboarding')).toBeHidden();

  // Re-open it from Settings — the tabs are reachable now the overlay is gone.
  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.getByRole('button', { name: 'Show setup guide' }).click();
  await expect(panel.getByTestId('first-run-onboarding')).toBeVisible();
});
