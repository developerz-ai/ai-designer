import type { BrowserContext, Page } from '@playwright/test';
import { expect, stubAuthProbe, test } from './fixtures';

// E2E: Ctrl/Alt+click to tell the agent WHICH element you mean, against a loaded extension.
//
// The whole point is grounding: "make this bigger" is unanswerable unless something pins what
// "this" is. jsdom (test/unit/picker.test.ts) proves the chord and the outline; only a real
// browser proves the rest of the chain — the content script's `element-picked` crossing the real
// chrome bus, the SW relaying it as `focus`, and the panel's context chip rendering it. That chain
// is exactly where it silently did nothing before.

const BASE_URL = 'https://openrouter.ai/api/v1';
const FIXTURE = 'https://openrouter.ai/e2e-fixture-quickpick/';

async function stubProvider(context: BrowserContext): Promise<void> {
  await context.route(`${BASE_URL}/models`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'test/pick', name: 'Test Pick' }] }),
    }),
  );
  await stubAuthProbe(context, BASE_URL);
}

async function stubFixture(context: BrowserContext): Promise<void> {
  await context.route(`${FIXTURE}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body:
        '<!doctype html><html><body>' +
        '<h1 id="hero">Hero</h1>' +
        '<button id="cta">Buy now</button>' +
        '<a id="link" href="/elsewhere">Elsewhere</a>' +
        '</body></html>',
    }),
  );
}

/** Configure + Start, so the composer (and its context chip) is mounted. */
async function startSession(panel: Page): Promise<void> {
  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.locator('#dz-key').fill('sk-or-test-quickpick');
  await panel.getByRole('button', { name: 'Refresh' }).click();
  await expect(panel.locator('#dz-model')).toHaveValue('test/pick');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await panel.getByRole('button', { name: 'Start designing' }).click();
  await expect(panel.getByPlaceholder('Tell the agent what to change…')).toBeVisible();
}

test('holding the modifier outlines the element under the pointer; clicking pins it as context', async ({
  context,
  openExtensionPage,
}) => {
  await stubProvider(context);
  await stubFixture(context);

  const panel = await openExtensionPage('sidepanel.html');
  await startSession(panel);

  const page = await context.newPage();
  await page.goto(`${FIXTURE}page`);
  await page.bringToFront();

  // Nothing on the page until the modifier is held — the content script is live on every page,
  // so an unheld pointer must change nothing at all.
  await page.locator('#cta').hover();
  await expect(page.locator('#dz-designer-picker')).toHaveCount(0);

  // Hold it: the picker's own outline + selector pill appear on whatever is hovered, so you can
  // see WHAT you are about to pin before you commit to it.
  await page.keyboard.down('Alt');
  await page.locator('#cta').hover();
  const outline = page.locator('#dz-designer-picker .dz-hover');
  await expect(outline).not.toHaveClass(/dz-hidden/);
  await expect(page.locator('#dz-designer-picker .dz-pill')).toContainText('#cta');

  // Click: pinned. The chip is the agent's context, and it names the resolved stable selector.
  await page.locator('#cta').click({ modifiers: ['Alt'] });
  await page.keyboard.up('Alt');
  await expect(panel.locator('.dz-context-chip')).toContainText('#cta');

  // Releasing the modifier clears the outline again.
  await expect(outline).toHaveClass(/dz-hidden/);
});

test('Ctrl+click pins an ordinary element, but leaves a link to the browser', async ({
  context,
  openExtensionPage,
}) => {
  await stubProvider(context);
  await stubFixture(context);

  const panel = await openExtensionPage('sidepanel.html');
  await startSession(panel);

  const page = await context.newPage();
  await page.goto(`${FIXTURE}page`);
  await page.bringToFront();

  await page.locator('#hero').click({ modifiers: ['Control'] });
  await expect(panel.locator('.dz-context-chip')).toContainText('#hero');

  // A link keeps Ctrl+click = "open in a new tab": the pin must NOT move to the link. (The new
  // tab Chrome opens for it is incidental — what matters is the chip still naming the heading.)
  await page.locator('#link').click({ modifiers: ['Control'] });
  await expect(panel.locator('.dz-context-chip')).toContainText('#hero');
});

test('an unmodified click is untouched — the page keeps working normally', async ({
  context,
  openExtensionPage,
}) => {
  await stubProvider(context);
  await stubFixture(context);

  const panel = await openExtensionPage('sidepanel.html');
  await startSession(panel);

  const page = await context.newPage();
  await page.goto(`${FIXTURE}page`);
  await page.bringToFront();
  await page.evaluate(() => {
    (window as unknown as { __clicked?: boolean }).__clicked = false;
    document.getElementById('cta')?.addEventListener('click', () => {
      (window as unknown as { __clicked?: boolean }).__clicked = true;
    });
  });

  await page.locator('#cta').click();

  // The page's own handler ran, and nothing was pinned.
  expect(await page.evaluate(() => (window as unknown as { __clicked?: boolean }).__clicked)).toBe(
    true,
  );
  await expect(panel.locator('.dz-context-chip')).toHaveCount(0);
});
