import type { BrowserContext, Worker } from '@playwright/test';
import { expect, test } from './fixtures';

// E2E: the content script's DOM-tool bus + picker overlay + screenshot capture (slice 05),
// against a loaded, real Chromium — the one thing jsdom (test/unit, test/integration) can't
// prove: that content.ts's chrome.runtime.onMessage wiring, the picker's shadow-DOM overlay,
// and background.ts's chrome.tabs.captureVisibleTab + OffscreenCanvas crop all work for real.
//
// The agent never runs here (that's slice 04's own mocked-model tests) — instead these drive
// the *exact* mechanism the agent uses: background.ts's `domDispatchFor` is nothing more than
// `chrome.tabs.sendMessage(tabId, tool)`, so calling that directly from the service worker
// (the same trick mcp.spec.ts uses for `sw.evaluate`) exercises the real cross-world bus without
// needing to fake an LLM's streaming tool-call response.
//
// The fixture page is served under `openrouter.ai` (intercepted, never leaves the machine) so
// the tab already has host permission from the manifest's static `host_permissions` — needed
// for `chrome.tabs.captureVisibleTab` in the screenshot spec, and reusing the same trick
// settings/mcp/readiness specs already use for stubbing that origin.
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture/';
const FIXTURE_HTML = `<!doctype html>
<html>
  <body>
    <h1 id="hero">Hero</h1>
    <button id="cta" data-testid="cta">Buy now</button>
    <div style="height: 3000px"></div>
    <div id="far">Far below the fold</div>
  </body>
</html>`;

interface StableSelectorLike {
  value: string;
  strategy: string;
  fragile: boolean;
}

interface ToolResultLike {
  ok: boolean;
  data?: unknown;
  error?: string;
  selector?: StableSelectorLike;
}

interface BusEventLike {
  type: string;
  [key: string]: unknown;
}

async function stubFixturePage(context: BrowserContext): Promise<void> {
  await context.route(`${FIXTURE_PREFIX}**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }),
  );
}

async function serviceWorker(context: BrowserContext): Promise<Worker> {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  return sw;
}

async function tabIdFor(sw: Worker, urlPrefix: string): Promise<number> {
  const id = await sw.evaluate(async (prefix) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url?.startsWith(prefix))?.id;
  }, urlPrefix);
  if (id === undefined) throw new Error(`no tab open under ${urlPrefix}`);
  return id;
}

// content.ts's onMessage listener registers at `document_idle`, a hair after `page.goto`
// resolves — the very first send can race a "Could not establish connection" rejection.
// Retry briefly instead of flaking.
async function sendToContent(
  sw: Worker,
  tabId: number,
  message: BusEventLike,
): Promise<ToolResultLike> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sw.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), {
        tabId,
        message,
      });
    } catch (err) {
      if (attempt >= 15) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

test('setStyle mutates the fixture page over the real content-script bus; undo reverts it', async ({
  context,
}) => {
  await stubFixturePage(context);
  const sw = await serviceWorker(context);
  const page = await context.newPage();
  await page.goto(`${FIXTURE_PREFIX}set-style`);
  const tabId = await tabIdFor(sw, FIXTURE_PREFIX);

  const cta = page.locator('#cta');
  const applied = 'rgb(16, 185, 129)';
  await expect(cta).not.toHaveCSS('background-color', applied);

  const result = await sendToContent(sw, tabId, {
    type: 'setStyle',
    selector: '#cta',
    props: { 'background-color': applied },
  });
  expect(result.ok).toBe(true);
  expect(result.selector?.value).toBe('[data-testid="cta"]');
  await expect(cta).toHaveCSS('background-color', applied);

  const undone = await sendToContent(sw, tabId, { type: 'undo' });
  expect(undone.ok).toBe(true);
  await expect(cta).not.toHaveCSS('background-color', applied);
});

test('picker highlights on hover and forwards a committed selection to the SW', async ({
  context,
}) => {
  await stubFixturePage(context);
  const sw = await serviceWorker(context);

  // An extra onMessage listener, piggybacked alongside background.ts's real one (Chrome fans
  // out to every registered listener), so we can assert the picker's pushes actually cross the
  // bus — not just that the content-script overlay renders.
  await sw.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eEvents: BusEventLike[] }).__e2eEvents = [];
    chrome.runtime.onMessage.addListener((msg: BusEventLike) => {
      (globalThis as typeof globalThis & { __e2eEvents: BusEventLike[] }).__e2eEvents.push(msg);
    });
  });

  const page = await context.newPage();
  await page.goto(`${FIXTURE_PREFIX}picker`);
  const tabId = await tabIdFor(sw, FIXTURE_PREFIX);

  await sendToContent(sw, tabId, { type: 'picker-start' });

  const cta = page.locator('#cta');
  await cta.hover();
  const hoverBox = page.locator('#dz-designer-picker .dz-hover');
  await expect(hoverBox).not.toHaveClass(/dz-hidden/);
  await expect(page.locator('#dz-designer-picker .dz-sel')).toHaveText('[data-testid="cta"]');

  // Shift-click commits a multi-selection — its persistent outline box is the picker's own
  // visible proof of "selected" (a plain click's single focus has no lingering chrome).
  await cta.click({ modifiers: ['Shift'] });
  await expect(page.locator('#dz-designer-picker .dz-box')).toHaveCount(1);

  await expect
    .poll(async () => {
      const events = await sw.evaluate(
        () => (globalThis as typeof globalThis & { __e2eEvents: BusEventLike[] }).__e2eEvents,
      );
      return events.map((e) => e.type);
    })
    .toContain('multi-select-changed');

  const events = await sw.evaluate(
    () => (globalThis as typeof globalThis & { __e2eEvents: BusEventLike[] }).__e2eEvents,
  );
  const committed = events.find((e) => e.type === 'multi-select-changed') as
    | { selectors: StableSelectorLike[] }
    | undefined;
  expect(committed?.selectors[0]?.value).toBe('[data-testid="cta"]');
});

// `chrome.tabs.captureVisibleTab` itself requires the `<all_urls>` or `activeTab` permission —
// neither of which a fresh profile has (`<all_urls>` is `optional_host_permissions`, needing a
// native runtime-permission prompt Playwright can't drive; activeTab needs a toolbar-icon click
// no CDP API can send either — see mcp.spec.ts's OAuth spec for the same wall). So this stubs
// that one native call (mirroring the OAuth spec's `launchWebAuthFlow` stub) and lets everything
// else run for real: content.ts's async CaptureRequest round trip, background.ts's capture
// listener, and its OffscreenCanvas crop math (`cropDataUrl`/`cropBox`).
const STUB_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('screenshot returns PNG bytes for vision self-correction', async ({ context }) => {
  await stubFixturePage(context);
  const sw = await serviceWorker(context);
  await sw.evaluate((stubDataUrl) => {
    chrome.tabs.captureVisibleTab = (() =>
      Promise.resolve(stubDataUrl)) as typeof chrome.tabs.captureVisibleTab;
  }, STUB_PNG_DATA_URL);

  const page = await context.newPage();
  await page.goto(`${FIXTURE_PREFIX}screenshot`);
  const tabId = await tabIdFor(sw, FIXTURE_PREFIX);

  const result = await sendToContent(sw, tabId, { type: 'screenshot', selector: '#cta' });
  expect(result.ok).toBe(true);
  expect(typeof result.data).toBe('string');
  const dataUrl = String(result.data);
  expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(Buffer.from(dataUrl.split(',')[1] ?? '', 'base64').length).toBeGreaterThan(50);
});

test('screenshot with no selector captures the full viewport', async ({ context }) => {
  await stubFixturePage(context);
  const sw = await serviceWorker(context);
  await sw.evaluate((stubDataUrl) => {
    chrome.tabs.captureVisibleTab = (() =>
      Promise.resolve(stubDataUrl)) as typeof chrome.tabs.captureVisibleTab;
  }, STUB_PNG_DATA_URL);

  const page = await context.newPage();
  await page.goto(`${FIXTURE_PREFIX}screenshot-viewport`);
  const tabId = await tabIdFor(sw, FIXTURE_PREFIX);

  const result = await sendToContent(sw, tabId, { type: 'screenshot' });
  expect(result.ok).toBe(true);
  expect(String(result.data)).toBe(STUB_PNG_DATA_URL); // whole-frame crop is a no-op (cropBox null)
});

test('screenshot scrolls a below-fold element into view for capture, then restores scroll (#59)', async ({
  context,
}) => {
  await stubFixturePage(context);
  const sw = await serviceWorker(context);
  await sw.evaluate((stubDataUrl) => {
    chrome.tabs.captureVisibleTab = (() =>
      Promise.resolve(stubDataUrl)) as typeof chrome.tabs.captureVisibleTab;
  }, STUB_PNG_DATA_URL);

  const page = await context.newPage();
  await page.goto(`${FIXTURE_PREFIX}screenshot-belowfold`);
  const tabId = await tabIdFor(sw, FIXTURE_PREFIX);

  // The tool restores scroll before returning, so a post-hoc scrollY check can't see it — record
  // the furthest the page scrolled while the tool ran.
  await page.evaluate(() => {
    const w = window as unknown as { __maxScrollY: number };
    w.__maxScrollY = 0;
    window.addEventListener(
      'scroll',
      () => {
        w.__maxScrollY = Math.max(w.__maxScrollY, window.scrollY);
      },
      { passive: true },
    );
  });

  // Precondition: #far starts below the fold with the page unscrolled.
  const startBelowFold = await page.evaluate(() => {
    const el = document.getElementById('far');
    return !!el && el.getBoundingClientRect().top > window.innerHeight && window.scrollY === 0;
  });
  expect(startBelowFold).toBe(true);

  const result = await sendToContent(sw, tabId, { type: 'screenshot', selector: '#far' });
  expect(result.ok).toBe(true);

  // jsdom can't prove this; a real browser can: the tool scrolled #far into view for the capture
  // (otherwise the crop is empty), then restored scroll so it stays a read.
  // The tool waits for the forward scroll and the restore to land, so by the time it returns the
  // page has visibly scrolled (maxScrollY>0) and is fully back at the top.
  const maxScrollY = await page.evaluate(
    () => (window as unknown as { __maxScrollY: number }).__maxScrollY,
  );
  expect(maxScrollY).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
