import type { BrowserContext, Worker } from '@playwright/test';
import { expect, test } from './fixtures';

// E2E: slice-15 complex-site tools (shadow-aware selectors ride the same content-script bus dom-
// tools.spec.ts already proves) against a loaded, real Chromium — the one thing jsdom (test/unit,
// test/integration) can't prove for THIS slice: that `widgetAct` drives a real ARIA widget end to
// end, that the MAIN-world bridge (src/entrypoints/injected.content.ts, a real, separate JS world
// from the isolated content script) really round-trips a page's own `Chart` global with no fake
// bridge, and that a real virtualized list only materializes an item into the DOM once a real
// browser `scroll` event carries it into view. Same direct-dispatch trick as dom-tools.spec.ts:
// `background.ts`'s `domDispatchFor`/`controlDispatchFor` is `chrome.tabs.sendMessage(tabId, tool)`,
// so calling that from the service worker exercises the real cross-world bus without needing to
// fake an LLM's tool-call stream.
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture-15/';

interface StableSelectorLike {
  value: string;
  strategy: string;
  fragile: boolean;
}

interface ToolResultLike {
  ok: boolean;
  data?: unknown;
  error?: string;
}

async function stubFixture(context: BrowserContext, path: string, html: string): Promise<void> {
  await context.route(`${FIXTURE_PREFIX}${path}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
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

// content.ts's onMessage listener registers at `document_idle`, a hair after `page.goto` resolves —
// the very first send can race a "Could not establish connection" rejection. Retry briefly instead
// of flaking (same pattern as dom-tools.spec.ts).
async function sendToContent(
  sw: Worker,
  tabId: number,
  message: Record<string, unknown>,
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

// Same ARIA calendar shape as test/unit/widgets.test.ts's `datetime` fixture (readCalMonth's
// caption regex, navButton's aria-label, role=gridcell days) — real click handlers, real DOM.
const DATETIME_COMBOBOX_HTML = `<!doctype html>
<html>
  <body>
    <button id="dt">Pick a date</button>
    <input id="combo" role="combobox" aria-controls="lb" />
    <ul id="lb" role="listbox">
      <li role="option">Apple</li>
      <li role="option">Banana</li>
    </ul>
    <p id="picked"></p>
    <script>
      document.getElementById('lb').addEventListener('click', function (e) {
        var opt = e.target.closest('[role="option"]');
        if (opt) document.getElementById('picked').textContent = opt.textContent;
      });

      var month = 1; // January (1-based) — several "next month" clicks needed to reach July.
      function render(cal) {
        var names = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July'];
        var days = [];
        for (var i = 1; i <= 20; i++) days.push('<button role="gridcell">' + i + '</button>');
        // A trailing space after the caption + a space between day buttons keeps a real word
        // boundary between "2026" and the day numbers — readCalMonth's year regex needs it.
        cal.innerHTML = '<div class="caption">' + names[month] + ' 2026</div> ' + days.join(' ');
        var next = document.createElement('button');
        next.setAttribute('aria-label', 'Next month');
        next.addEventListener('click', function () {
          month += 1;
          render(cal);
        });
        cal.appendChild(next);
      }
      document.getElementById('dt').addEventListener('click', function () {
        var cal = document.createElement('div');
        cal.setAttribute('role', 'grid');
        document.body.appendChild(cal);
        render(cal);
      });
    </script>
  </body>
</html>`;

test('widgetAct drives a real datetime picker and combobox on a fixture SPA', async ({
  context,
}) => {
  await stubFixture(context, 'widgets', DATETIME_COMBOBOX_HTML);
  const sw = await serviceWorker(context);
  const page = await context.newPage();
  await page.goto(`${FIXTURE_PREFIX}widgets`);
  const tabId = await tabIdFor(sw, FIXTURE_PREFIX);

  const datetimeResult = await sendToContent(sw, tabId, {
    type: 'widgetAct',
    recipe: { type: 'datetime', selector: '#dt', date: '2026-07-14' },
  });
  expect(datetimeResult.ok).toBe(true);
  const datetimeData = datetimeResult.data as { reached: boolean; steps: string[] };
  expect(datetimeData.reached).toBe(true);
  // Real month navigation actually ran (6x "January" -> "July") rather than picking day 14 of
  // whatever month happened to be showing — the caption really reached July before the click.
  expect(datetimeData.steps.filter((s) => s === 'next month')).toHaveLength(6);
  await expect(page.locator('.caption')).toHaveText('July 2026');

  const comboResult = await sendToContent(sw, tabId, {
    type: 'widgetAct',
    recipe: { type: 'combobox', selector: '#combo', value: 'Banana' },
  });
  expect(comboResult.ok).toBe(true);
  expect((comboResult.data as { state?: { value: string } }).state?.value).toBe('Banana');
  // The real option's own click handler fired (not a mocked one).
  await expect(page.locator('#picked')).toHaveText('Banana');
  await expect(page.locator('#combo')).toHaveValue('Banana');
});

// Defines `window.Chart` exactly as the real Chart.js UMD global shapes it (an `instances` map
// keyed by chart id) — this is a REAL separate MAIN-world global the isolated content script can
// never see directly, so a successful `source:'data'` read here proves the bridge (src/dom/
// bridge.ts client + src/entrypoints/injected.content.ts server) really crossed worlds for real.
const CHARTJS_HTML = `<!doctype html>
<html>
  <body>
    <canvas id="revenue"></canvas>
    <script>
      window.Chart = {
        instances: {
          0: {
            config: { type: 'bar' },
            data: { labels: ['Q1', 'Q2'], datasets: [{ label: 'Revenue', data: [10, 20] }] },
            canvas: document.getElementById('revenue'),
          },
        },
      };
    </script>
  </body>
</html>`;

const BARE_CANVAS_HTML = `<!doctype html>
<html>
  <body>
    <canvas id="mystery" width="200" height="100"></canvas>
  </body>
</html>`;

test('readChart pulls series over the real MAIN-world bridge from a page-defined Chart.js global', async ({
  context,
}) => {
  await stubFixture(context, 'chartjs', CHARTJS_HTML);
  const sw = await serviceWorker(context);
  const page = await context.newPage();
  await page.goto(`${FIXTURE_PREFIX}chartjs`);
  const tabId = await tabIdFor(sw, FIXTURE_PREFIX);

  const result = await sendToContent(sw, tabId, { type: 'readChart' });

  expect(result.ok).toBe(true);
  const data = result.data as {
    source: string;
    charts: Array<{ lib: string; kind?: string; selector?: string; labels?: string[] }>;
  };
  expect(data.source).toBe('data');
  expect(data.charts[0]?.lib).toBe('chartjs');
  expect(data.charts[0]?.kind).toBe('bar');
  expect(data.charts[0]?.selector).toBe('#revenue');
  expect(data.charts[0]?.labels).toEqual(['Q1', 'Q2']);
});

test('readChart falls back to vision targets for an unreadable canvas (no known chart lib)', async ({
  context,
}) => {
  await stubFixture(context, 'bare-canvas', BARE_CANVAS_HTML);
  const sw = await serviceWorker(context);
  const page = await context.newPage();
  await page.goto(`${FIXTURE_PREFIX}bare-canvas`);
  const tabId = await tabIdFor(sw, FIXTURE_PREFIX);

  const result = await sendToContent(sw, tabId, { type: 'readChart' });

  expect(result.ok).toBe(true);
  const data = result.data as { source: string; targets: string[]; reason?: string };
  expect(data.source).toBe('vision');
  expect(data.targets).toContain('canvas');
  expect(data.reason).toBeTruthy();
});

// A window-scroll-driven virtualized list (the common real-world shape — infinite feeds key off
// window scroll, not an inner container): only the items within +/-2 rows of the viewport are ever
// materialized. Item 150 does not exist in the DOM until a real browser `scroll` event past it fires.
const VIRTUALIZED_LIST_HTML = `<!doctype html>
<html>
  <body style="margin:0">
    <div id="spacer" style="height:8000px;position:relative"></div>
    <script>
      var ITEM_H = 40, COUNT = 200, VISIBLE = 12;
      var spacer = document.getElementById('spacer');
      function render() {
        var top = window.scrollY;
        var start = Math.max(0, Math.floor(top / ITEM_H) - 2);
        var end = Math.min(COUNT, start + VISIBLE + 4);
        spacer.innerHTML = '';
        for (var i = start; i < end; i++) {
          var el = document.createElement('div');
          el.className = 'item';
          el.dataset.idx = String(i);
          el.textContent = 'Item ' + i;
          el.style.position = 'absolute';
          el.style.top = (i * ITEM_H) + 'px';
          el.style.height = ITEM_H + 'px';
          spacer.appendChild(el);
        }
      }
      window.addEventListener('scroll', render);
      render();
    </script>
  </body>
</html>`;

test('scrollTo + query re-discovers a virtualized item that only renders after a real scroll', async ({
  context,
}) => {
  await stubFixture(context, 'virtual-list', VIRTUALIZED_LIST_HTML);
  const sw = await serviceWorker(context);
  const page = await context.newPage();
  await page.goto(`${FIXTURE_PREFIX}virtual-list`);
  const tabId = await tabIdFor(sw, FIXTURE_PREFIX);

  const before = await sendToContent(sw, tabId, {
    type: 'query',
    selector: '.item[data-idx="150"]',
  });
  expect(before.ok).toBe(true);
  expect((before.data as { matches: StableSelectorLike[] }).matches).toHaveLength(0);

  const scrolled = await sendToContent(sw, tabId, { type: 'scrollTo', y: 6000 });
  expect(scrolled.ok).toBe(true);

  const waited = await sendToContent(sw, tabId, {
    type: 'waitFor',
    selector: '.item[data-idx="150"]',
    timeMs: 5000,
  });
  expect(waited.ok).toBe(true);
  expect((waited.data as { met: boolean }).met).toBe(true);

  const after = await sendToContent(sw, tabId, {
    type: 'query',
    selector: '.item[data-idx="150"]',
  });
  expect((after.data as { matches: StableSelectorLike[] }).matches).toHaveLength(1);

  // Virtualization actually evicted the far-away top items — proves this is a real re-render, not
  // an accumulating list.
  const gone = await sendToContent(sw, tabId, { type: 'query', selector: '.item[data-idx="0"]' });
  expect((gone.data as { matches: StableSelectorLike[] }).matches).toHaveLength(0);
});
