import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// E2E: the on-page agent-decision overlay (slice 09), opt-in, against a loaded, real Chromium —
// the one thing jsdom (test/unit/overlay.test.ts, test/integration/overlay-forward.test.ts) can't
// prove: that the ReadinessDropdown's real toggle flips background.ts's persisted opt-in, that a
// real agent turn's tool-call stream reaches content.ts's OverlayCmd listener over the actual
// chrome bus, and that the shadow-DOM overlay it paints tracks the mutated element on the real
// page. Mirrors copy-debug.spec.ts's approach: the composer is still a UI stub, so the turn is
// driven via the same `user-message` RPC the composer will eventually send, against a real
// `@ai-sdk/openai-compatible` stream intercepted at the wire (canned HTTP, not a fake LanguageModel).

const BASE_URL = 'https://openrouter.ai/api/v1';
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture-09/';

async function stubModels(context: BrowserContext): Promise<void> {
  await context.route(`${BASE_URL}/models`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'test/overlay', name: 'Test Overlay' }] }),
    }),
  );
}

async function stubOwnFixture(context: BrowserContext): Promise<void> {
  await context.route(`${FIXTURE_PREFIX}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body:
        '<!doctype html><html><body><h1 id="hero">Hero</h1>' +
        '<button id="cta" data-testid="cta">Buy now</button></body></html>',
    }),
  );
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const payload = {
    id: 'e2e-chunk',
    created: 0,
    model: 'test/overlay',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason
      ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      : {}),
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textStream(text: string): string {
  return (
    sseChunk({ role: 'assistant' }) +
    sseChunk({ content: text }) +
    sseChunk({}, 'stop') +
    'data: [DONE]\n\n'
  );
}

function toolCallStream(toolCallId: string, name: string, args: unknown): string {
  return (
    sseChunk({ role: 'assistant' }) +
    sseChunk({
      tool_calls: [
        {
          index: 0,
          id: toolCallId,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }) +
    sseChunk({}, 'tool_calls') +
    'data: [DONE]\n\n'
  );
}

async function stubChat(context: BrowserContext, turns: string[]): Promise<number[]> {
  const seen: number[] = [];
  await context.route(`${BASE_URL}/chat/completions`, async (route) => {
    const index = seen.length;
    seen.push(index);
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: turns[index] ?? textStream('(unexpected extra turn)'),
    });
  });
  return seen;
}

async function configureProvider(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-key').fill('sk-or-test-09');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model option')).toHaveText(['Test Overlay']);
  await page.locator('#dz-model').selectOption('test/overlay');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');
}

// Opens the header's readiness dropdown, exposing the "On-page overlay" switch.
async function openReadinessPanel(panel: Page): Promise<void> {
  await panel.locator('.dz-readiness__pill').click();
  await expect(panel.getByRole('switch')).toBeVisible();
}

async function sendUserMessage(page: Page, text: string): Promise<void> {
  await page.evaluate((text) => chrome.runtime.sendMessage({ type: 'user-message', text }), text);
}

test('enable overlay -> run a turn -> it shows steps and highlights the mutated element; toggle off removes it', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubOwnFixture(context);
  const requests = await stubChat(context, [
    toolCallStream('call-query', 'query', { selector: '#cta' }),
    toolCallStream('call-set-style', 'setStyle', {
      selector: '#cta',
      props: { 'background-color': '#f97316' },
    }),
    textStream('Recolored the CTA.'),
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);

  const ownPage = await context.newPage();
  await ownPage.goto(`${FIXTURE_PREFIX}own`);
  await ownPage.bringToFront(); // background.ts targets the active tab of the last-focused window

  // Opt in: the toggle round-trips through the real set-overlay-enabled RPC, which persists the
  // flag AND immediately pushes an overlay-toggle to the (now active) own page.
  await openReadinessPanel(panel);
  const toggle = panel.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toHaveText('On');

  await sendUserMessage(panel, 'Recolor the CTA');

  // Two model calls: query -> setStyle -> a final summary is the third.
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(3);

  // The overlay's shadow-DOM chrome mounted on the real page (Playwright pierces open shadow
  // roots for a plain descendant selector — same trick dom-tools.spec.ts uses for the picker).
  const now = ownPage.locator('#dz-designer-overlay .dz-now');
  const mark = ownPage.locator('#dz-designer-overlay .dz-mark');

  // Steps: both the read (query) and the act (setStyle) landed in the scrolling log.
  await expect(ownPage.locator('#dz-designer-overlay .dz-log-item')).toHaveCount(2);
  // The banner reflects the latest (mutating) step, in the same "tool → selector" shape the
  // panel's own tool-call chip would use (src/shared/overlay-step.ts `overlayLabel`).
  await expect(now).toHaveText('setStyle → #cta');
  await expect(now).toHaveClass(/dz-act/);

  // Highlight: visible, and placed exactly on the mutated element.
  await expect(mark).not.toHaveClass(/dz-hidden/);
  const ctaBox = await ownPage.locator('#cta').boundingBox();
  const markBox = await mark.boundingBox();
  expect(ctaBox).not.toBeNull();
  expect(markBox).not.toBeNull();
  expect(markBox?.x).toBeCloseTo(ctaBox?.x ?? Number.NaN, 0);
  expect(markBox?.y).toBeCloseTo(ctaBox?.y ?? Number.NaN, 0);
  expect(markBox?.width).toBeCloseTo(ctaBox?.width ?? Number.NaN, 0);

  // The mutation itself actually applied — the overlay is watching a real turn, not a stub.
  await expect(ownPage.locator('#cta')).toHaveCSS('background-color', 'rgb(249, 115, 22)');

  // Toggle off: the host is torn out of the page entirely, not merely hidden.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(ownPage.locator('#dz-designer-overlay')).toHaveCount(0);
});
