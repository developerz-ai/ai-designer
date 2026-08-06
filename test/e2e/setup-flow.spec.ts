import type { BrowserContext } from '@playwright/test';
import { expect, openRoom, stubAuthProbe, test } from './fixtures';

// E2E: the whole first-run path a new user walks — install → the panel tells you setup is needed
// → configure a provider → start → the conversation. Every step used to name its next action
// without offering it: the pre-Start screen was one sentence pointing at a Start button in the
// header, and a finished Settings form left you on a finished Settings form. This asserts the
// actions exist where the user is looking.

const BASE_URL = 'https://openrouter.ai/api/v1';

async function stubProvider(context: BrowserContext): Promise<void> {
  await context.route(`${BASE_URL}/models`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'test/flow', name: 'Test Flow' }] }),
    }),
  );
  await stubAuthProbe(context, BASE_URL);
}

test('install -> "set up provider" -> configure -> "start designing" -> the conversation', async ({
  context,
  openExtensionPage,
}) => {
  await stubProvider(context);
  const page = await openExtensionPage('sidepanel.html');

  // 1. The chat surface on a fresh profile: it says what is missing AND offers the way there.
  await expect(
    page.getByText('Configure a provider above, then hit Start to begin chatting.'),
  ).toBeVisible();
  const setup = page.getByRole('button', { name: 'Set up provider' });
  await expect(setup).toBeVisible();
  await setup.click();

  // 2. It landed on Settings — no hunting through the tab bar.
  await expect(page.locator('#dz-key')).toBeVisible();

  // 3. Configure. The verdict stays on screen (the panel does NOT navigate away on save).
  await page.locator('#dz-key').fill('sk-or-test-flow');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model')).toHaveValue('test/flow');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');

  // 4. …and the next step appears right underneath it.
  const start = page.getByRole('button', { name: 'Start designing' });
  await expect(start).toBeVisible();
  await start.click();

  // 5. The session is live and the composer is there — one continuous path from install.
  await expect(page.getByPlaceholder('Tell the agent what to change…')).toBeVisible();
  await expect(page.locator('.dz-readiness__toggle')).toHaveText('Stop');
});

test('a configured-but-not-started panel offers Start from the chat surface itself', async ({
  context,
  openExtensionPage,
}) => {
  await stubProvider(context);
  const page = await openExtensionPage('sidepanel.html');

  await openRoom(page, 'Settings');
  await page.locator('#dz-key').fill('sk-or-test-flow2');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model')).toHaveValue('test/flow');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');

  // Back to Chat WITHOUT using the post-save CTA: the pre-Start screen has itself re-read
  // readiness and now offers Start rather than repeating the setup instruction.
  await openRoom(page, 'Chat');
  await expect(
    page.getByText('Start a session and tell the agent what to change on this page.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start designing' }).click();
  await expect(page.getByPlaceholder('Tell the agent what to change…')).toBeVisible();
});

test('the readiness pill reads green without a spinner while a session is open', async ({
  context,
  openExtensionPage,
}) => {
  await stubProvider(context);
  const page = await openExtensionPage('sidepanel.html');

  await openRoom(page, 'Settings');
  await page.locator('#dz-key').fill('sk-or-test-flow3');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model')).toHaveValue('test/flow');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Start designing' }).click();

  const pill = page.locator('.dz-readiness__pill');
  await expect(pill).toHaveText(/Running…/);
  // An open session is a healthy STATE, not a wait: green, and no spinning wheel. The pill used
  // to spin for the entire life of the session, which reads as "busy, hold on" between turns.
  await expect(pill).toHaveClass(/is-ready/);
  await expect(pill.locator('.dz-icon--spin')).toHaveCount(0);
});
