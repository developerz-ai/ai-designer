import type { BrowserContext, Worker } from '@playwright/test';
import { expect, test } from './fixtures';

// E2E: the slice-16 responsive/mobile tools driven against a loaded, real Chromium — the one
// thing jsdom (test/unit, test/integration) can't prove: that background.ts's real
// chrome.debugger/chrome.windows device-emulation glue and chrome.tabs.captureVisibleTab compose
// with the real content-world scanner (src/dom/responsive.ts) end to end. Same trick as
// control-vision.spec.ts: a real `@ai-sdk/openai-compatible` stream intercepted at the wire drives
// the SW's already-real `user-message` handler, so setDevice -> checkResponsive -> responsiveCapture
// run through the actual agent loop, not a hand-rolled harness.
//
// Device emulation is best-effort in this environment (chrome.debugger may fail to attach because
// Playwright's own CDP session already owns the target — `applyDevice` degrades to the viewport
// fallback exactly as docs/plans/.../16-responsive-mobile.md's "Emulation mechanism" describes),
// so assertions accept either `mechanism` rather than pinning to `"cdp"`. What's real regardless of
// mechanism: the scanner reads the actual DOM/CSSOM of a loaded page, and captureVisibleTab (stubbed,
// like dom-tools.spec.ts) returns real PNG bytes fanned out per breakpoint.

const BASE_URL = 'https://openrouter.ai/api/v1';
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture-16/';

async function stubModels(context: BrowserContext): Promise<void> {
  await context.route(`${BASE_URL}/models`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'test/responsive', name: 'Test Responsive' }] }),
    }),
  );
}

async function stubFixtures(context: BrowserContext, pages: Record<string, string>): Promise<void> {
  await context.route(`${FIXTURE_PREFIX}**`, (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const body = pages[key];
    if (body === undefined) {
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
    model: 'test/responsive',
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

async function configureProvider(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-key').fill('sk-or-test-16');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model option')).toHaveText(['Test Responsive']);
  await page.locator('#dz-model').selectOption('test/responsive');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');
}

async function sendUserMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.evaluate(
    (text) => chrome.runtime.sendMessage({ type: 'user-message', text, mode: 'debug' }),
    text,
  );
}

async function serviceWorker(context: BrowserContext): Promise<Worker> {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  return sw;
}

// A 1x1 PNG — chrome.tabs.captureVisibleTab needs a permission a fresh profile doesn't hold, so
// this stubs that one native call (mirroring dom-tools.spec.ts / control-vision.spec.ts) and lets
// the real setDevice/responsiveCapture/checkResponsive pipeline run around it.
const STUB_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function stubCaptureVisibleTab(sw: Worker): Promise<void> {
  await sw.evaluate((stubDataUrl) => {
    chrome.tabs.captureVisibleTab = (() =>
      Promise.resolve(stubDataUrl)) as typeof chrome.tabs.captureVisibleTab;
  }, STUB_PNG_DATA_URL);
}

test('setDevice then checkResponsive flags a real horizontal-overflow bug on a mobile-broken fixture', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context, {
    'mobile-overflow':
      '<!doctype html><html><body style="margin:0">' +
      // Wider than any real viewport this test could run in, so the page-level overflow finding
      // (`scrollWidth > clientWidth`) fires regardless of the host window's actual size.
      '<div id="banner" style="width:4000px;height:80px;background:#f00">too wide for mobile</div>' +
      '</body></html>',
  });

  const requests = await stubChat(context, [
    toolCallStream('call-device', 'setDevice', { preset: 'iphone-15' }),
    toolCallStream('call-check', 'checkResponsive', {}),
    textStream('The banner forces horizontal scroll on mobile.'),
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);

  const page = await context.newPage();
  await page.goto(`${FIXTURE_PREFIX}mobile-overflow`);
  await page.bringToFront();

  const sw = await serviceWorker(context);
  await stubCaptureVisibleTab(sw);

  await sendUserMessage(panel, 'Check this page on mobile for responsive problems');

  // Three model calls: setDevice -> checkResponsive -> final summary.
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(3);

  // setDevice really applied (CDP if attach succeeded, else the viewport fallback — either is a
  // valid outcome per plan 16's "Emulation mechanism" decision).
  const afterDevice = requests[1]?.messages.at(-1);
  expect(afterDevice?.role).toBe('tool');
  const deviceResult = String(afterDevice?.content);
  expect(deviceResult).toContain('"ok":true');
  expect(deviceResult).toMatch(/"mechanism":"(cdp|viewport)"/);

  // checkResponsive ran the REAL content-world scanner against the REAL fixture DOM and flagged
  // the seeded overflow — not a mocked tool result.
  const afterCheck = requests[2]?.messages.at(-1);
  expect(afterCheck?.role).toBe('tool');
  const checkResult = String(afterCheck?.content);
  expect(checkResult).toContain('"ok":true');
  expect(checkResult).toContain('"category":"overflow"');
  expect(checkResult).toContain('"severity":"serious"');
});

test('responsiveCapture returns a mobile and a desktop shot for the vision model', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context, {
    plain: '<!doctype html><html><body><h1>Plain page</h1></body></html>',
  });

  const requests = await stubChat(context, [
    toolCallStream('call-capture', 'responsiveCapture', {
      breakpoints: [
        { preset: 'iphone-15', label: 'Mobile' },
        { preset: 'desktop', label: 'Desktop' },
      ],
    }),
    textStream('Compared the mobile and desktop layouts.'),
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);

  const page = await context.newPage();
  await page.goto(`${FIXTURE_PREFIX}plain`);
  await page.bringToFront();

  const sw = await serviceWorker(context);
  await stubCaptureVisibleTab(sw);

  await sendUserMessage(panel, 'Show me this page on mobile and desktop');

  // Two model calls: responsiveCapture -> final summary.
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(2);

  const afterCapture = requests[1]?.messages.at(-1);
  expect(afterCapture?.role).toBe('tool');
  const captured = String(afterCapture?.content);
  // The loop's `responsiveCaptureToModelOutput` hook fans successful shots out as a caption + an
  // image part per breakpoint, labeled by the breakpoint name the model asked for.
  expect(captured).toMatch(/Mobile \(\d+×\d+,\s*(cdp|viewport)\)/);
  expect(captured).toMatch(/Desktop \(\d+×\d+,\s*(cdp|viewport)\)/);
  expect(captured).toContain('"mediaType":"image/png"');
});
