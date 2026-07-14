import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// E2E: the slice-13 browser-control + vision tools driven against a loaded, real Chromium — the
// one thing jsdom (test/unit, test/integration) can't prove: that content.ts's real
// click/waitFor/readImages wiring, background.ts's real full-page scroll-stitch
// (chrome.tabs.captureVisibleTab + OffscreenCanvas), and a real cross-frame `navigate` all work
// end to end. Same trick as copy-debug.spec.ts: a real `@ai-sdk/openai-compatible` stream
// intercepted at the wire (canned HTTP responses, not a fake LanguageModel) drives the SW's
// already-real `user-message` handler, so the full loop — SW -> provider -> tool bus -> content
// script -> real page — runs for real; only the fixture pages and the LLM's replies are canned.

const BASE_URL = 'https://openrouter.ai/api/v1';
// Distinct prefix from the other e2e specs' fixtures so routes never collide even if Playwright
// ever shared a context (it doesn't — each test gets its own persistent context regardless).
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture-13/';

async function stubModels(context: BrowserContext): Promise<void> {
  await context.route(`${BASE_URL}/models`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'test/vision', name: 'Test Vision' }] }),
    }),
  );
}

async function stubFixtures(context: BrowserContext, pages: Record<string, string>): Promise<void> {
  await context.route(`${FIXTURE_PREFIX}**`, (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const body = pages[key];
    if (body === undefined) {
      // Also covers the seeded broken <img>: any path not declared in `pages` 404s, exactly
      // like a real missing asset — readImages' `broken` flag is a real load failure, not a mock.
      route.fulfill({ status: 404, body: '' });
      return;
    }
    route.fulfill({ status: 200, contentType: 'text/html', body });
  });
}

interface ChatMessage {
  role: string;
  content?: unknown;
}
interface ChatRequestBody {
  messages: ChatMessage[];
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const payload = {
    id: 'e2e-chunk',
    created: 0,
    model: 'test/vision',
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

async function stubChat(context: BrowserContext, turns: string[]): Promise<ChatRequestBody[]> {
  const requests: ChatRequestBody[] = [];
  await context.route(`${BASE_URL}/chat/completions`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as ChatRequestBody;
    const index = requests.length;
    requests.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: turns[index] ?? textStream('(unexpected extra turn)'),
    });
  });
  return requests;
}

async function configureProvider(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-key').fill('sk-or-test-13');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model option')).toHaveText(['Test Vision']);
  await page.locator('#dz-model').selectOption('test/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');
}

async function sendUserMessage(page: Page, text: string): Promise<void> {
  await page.evaluate(
    (text) => chrome.runtime.sendMessage({ type: 'user-message', text, mode: 'debug' }),
    text,
  );
}

async function serviceWorker(context: BrowserContext) {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  return sw;
}

// A 1x1 PNG — `chrome.tabs.captureVisibleTab` needs the `<all_urls>`/`activeTab` permission a
// fresh profile doesn't hold and Playwright can't grant via a native prompt, so this stubs that
// one native call (mirroring dom-tools.spec.ts's screenshot specs) and lets the real scroll-stitch
// pipeline (planStitch bands, per-band scrollTo + captureVisibleTab, OffscreenCanvas compose) run.
const STUB_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function stubCaptureVisibleTab(sw: Awaited<ReturnType<typeof serviceWorker>>): Promise<void> {
  await sw.evaluate((stubDataUrl) => {
    chrome.tabs.captureVisibleTab = (() =>
      Promise.resolve(stubDataUrl)) as typeof chrome.tabs.captureVisibleTab;
  }, STUB_PNG_DATA_URL);
}

test('drives a fixture: click reveals content, waitFor sees it, a full-page screenshot stitches the tall page, and readImages flags the seeded broken image', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context, {
    drive:
      '<!doctype html><html><body style="margin:0">' +
      // Taller than one viewport so the full-page capture must scroll-stitch more than one band.
      '<div style="height:2400px">' +
      '<button id="reveal">Reveal</button><div id="content"></div>' +
      '</div>' +
      `<img id="broken" alt="missing" src="${FIXTURE_PREFIX}does-not-exist.png" />` +
      '<script>' +
      "document.getElementById('reveal').addEventListener('click', function () {" +
      "  var p = document.createElement('p'); p.id = 'more'; p.textContent = 'More content loaded';" +
      "  document.getElementById('content').appendChild(p);" +
      '});' +
      '</script>' +
      '</body></html>',
  });

  const requests = await stubChat(context, [
    toolCallStream('call-click', 'click', { selector: '#reveal' }),
    toolCallStream('call-wait', 'waitFor', { selector: '#more', timeMs: 5000 }),
    toolCallStream('call-shot', 'screenshot', { fullPage: true }),
    toolCallStream('call-images', 'readImages', {}),
    textStream('Revealed the content, captured the full page, and found one broken image.'),
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);

  const sw = await serviceWorker(context);
  await stubCaptureVisibleTab(sw);

  const drivePage = await context.newPage();
  await drivePage.goto(`${FIXTURE_PREFIX}drive`);
  await drivePage.bringToFront(); // background.ts targets the active tab of the last-focused window

  await sendUserMessage(
    panel,
    'Reveal the hidden content, capture the full page, and check images',
  );

  // Five model calls: click -> waitFor -> screenshot -> readImages -> final summary.
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(5);

  // click actually landed on the real page (not just a mocked tool result).
  await expect(drivePage.locator('#more')).toHaveText('More content loaded');

  // The model saw a real ok:true click result …
  const afterClick = requests[1]?.messages.at(-1);
  expect(afterClick?.role).toBe('tool');
  expect(String(afterClick?.content)).toContain('"ok":true');

  // … waitFor genuinely observed the element that the click produced (met:true, not a timeout).
  const afterWait = requests[2]?.messages.at(-1);
  expect(String(afterWait?.content)).toContain('"met":true');

  // … the full-page screenshot succeeded: the loop's screenshotToModelOutput hook only fires its
  // vision hint text on a successful capture (a failed one falls back to the plain JSON error).
  const afterShot = requests[3]?.messages.at(-1);
  expect(afterShot?.role).toBe('tool');
  expect(JSON.stringify(afterShot?.content)).toContain('Screenshot of the current result');

  // … and readImages flagged the seeded broken <img> for real (a genuine 404 load failure).
  const afterImages = requests[4]?.messages.at(-1);
  expect(afterImages?.role).toBe('tool');
  const imagesShown = String(afterImages?.content);
  expect(imagesShown).toContain('"ok":true');
  expect(imagesShown).toContain('"broken":true');
  expect(imagesShown).toContain('#broken');
});

test('navigate crosses from one fixture page to another and the agent keeps driving the new page', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context, {
    start: '<!doctype html><html><body><h1>Page One</h1><a id="away">ignore me</a></body></html>',
    landing:
      '<!doctype html><html><body><h1>Page Two</h1>' +
      '<button id="next" data-testid="next">Confirm</button></body></html>',
  });

  const requests = await stubChat(context, [
    toolCallStream('call-nav', 'navigate', { url: `${FIXTURE_PREFIX}landing` }),
    toolCallStream('call-click', 'click', { selector: '#next' }),
    textStream('Navigated to page two and confirmed.'),
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);

  const page = await context.newPage();
  await page.goto(`${FIXTURE_PREFIX}start`);
  await page.bringToFront();

  await sendUserMessage(panel, 'Go to page two and confirm');

  // Three model calls: navigate -> click -> final summary.
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(3);

  // The tab really navigated to the second fixture …
  await expect(page).toHaveURL(`${FIXTURE_PREFIX}landing`);
  await expect(page.locator('h1')).toHaveText('Page Two');

  // … the model saw where navigation landed …
  const afterNav = requests[1]?.messages.at(-1);
  expect(afterNav?.role).toBe('tool');
  expect(String(afterNav?.content)).toContain(`${FIXTURE_PREFIX}landing`);

  // … and drove the NEW page's content script afterwards (the old page's script is gone —
  // navigation tore it down — so this only passes against the freshly injected one).
  const afterClick = requests[2]?.messages.at(-1);
  expect(String(afterClick?.content)).toContain('"ok":true');
});
