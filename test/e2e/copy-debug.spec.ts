import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// E2E: the two headline agent activities (plan 06, `06-browse-copy-debug.md`) driven against a
// loaded, real Chromium. The composer itself is still a UI stub (ChatPanel.tsx: "Wiring to the SW
// message bus is TODO" — landed in a later slice), so these send the same `user-message` RPC the
// composer will eventually send straight to the already-real, already-wired SW handler
// (background.ts `case 'user-message'`) — mirroring dom-tools.spec.ts's "drive the exact mechanism
// the agent uses" approach rather than a mock of our own code. The model is a real
// `@ai-sdk/openai-compatible` stream intercepted at the wire (canned HTTP responses, not a fake
// LanguageModel), so the full loop — SW -> provider -> tool bus -> content script -> real page —
// runs for real; only the two fixture "sites" and the LLM's replies are canned.
//
// Copy: browse a reference fixture in a background tab, then apply + durably record a matching
// edit on the user's own fixture tab (06 step 5). Debug: a real seeded accessibility problem,
// caught by the content script's live diagnostics scan (not a mock), reaches the model via the
// `diagnostics` tool and turns into a proposed fix (06 step 6).
//
// Diagnostics category note: `scan` (a11y/layout) reads the shared DOM directly, so it sees a
// real page bug regardless of world. `drain` (console/exception/fetch hooks) patches globals
// INSIDE the content script's isolated world (`src/dom/diagnostics-collector.ts`
// `defaultHookTarget`) — verified empirically against this loaded build that an isolated-world
// hook does not observe a same-named global mutated/called from the page's own MAIN-world script
// (a `console.error`, a thrown exception, or a broken-image resource event fired by the page
// never reached it), which is why the debug case below seeds an a11y issue rather than a console
// error: it exercises the identical `diagnostics` tool/engine wiring against a signal category
// that is actually observable cross-world in a real browser, not a mocked one.

const BASE_URL = 'https://openrouter.ai/api/v1';
// Distinct from dom-tools.spec.ts's FIXTURE_PREFIX so the two files' routes never overlap even if
// Playwright ever shares a context — each test still gets its own persistent context regardless.
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture-06/';

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

// One OpenAI-compatible `chat.completion.chunk` SSE event.
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

// A one-shot plain-text turn: role delta, the full text in one delta, `stop`.
function textStream(text: string): string {
  return (
    sseChunk({ role: 'assistant' }) +
    sseChunk({ content: text }) +
    sseChunk({}, 'stop') +
    'data: [DONE]\n\n'
  );
}

// A one-shot tool-call turn: the full name + arguments arrive in a single delta (a compliant
// OpenAI-compatible server may do this; @ai-sdk/provider-utils's StreamingToolCallTracker forwards
// a complete tool-call as soon as `function.name` is present, so this doesn't need multi-chunk
// argument streaming to exercise the real tool-call path).
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

// Sequenced `/chat/completions` stub: the Nth POST gets `turns[N]`; running past the end replies
// with an inert text turn so an unexpected extra step fails an assertion instead of hanging the
// test. Every parsed request body is captured, in order — the e2e equivalent of browse-loop.test.ts's
// `browseResultShownToModel`: proof of exactly what the model was shown for each tool result.
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

// Configure a BYOK provider through the real Settings UI (mirrors settings.spec.ts /
// readiness.spec.ts) so `getProviderConfig()` is populated before `user-message` is sent.
async function configureProvider(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-key').fill('sk-or-test-06');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model option')).toHaveText(['Test Vision']);
  await page.locator('#dz-model').selectOption('test/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');
}

// The RPC ChatPanel's composer will eventually send (background.ts's real, already-wired
// `user-message` handler) — see file header.
async function sendUserMessage(page: Page, text: string, mode: 'copy' | 'debug'): Promise<void> {
  await page.evaluate(
    ({ text, mode }) => chrome.runtime.sendMessage({ type: 'user-message', text, mode }),
    { text, mode },
  );
}

async function serviceWorker(context: BrowserContext) {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  return sw;
}

// Harness-only fix for a Playwright/CDP quirk (verified empirically against this loaded build,
// unrelated to any real Chrome/user behavior): `chrome.tabs.create({ url })` begins navigating
// the instant it's called, and Playwright's context-level `route()` interception attaches to a
// brand-new target asynchronously — so the very first request can slip out to the real network
// before the route is wired up, and `browse()`'s reference-site request silently hits the real
// openrouter.ai instead of the stub. `page.goto()`-created pages (every other spec's pattern)
// don't race because Playwright creates and attaches to those targets itself before navigating.
// The fix: make the SW's `chrome.tabs.create` open `about:blank` first (Playwright reliably
// attaches to that idle target), then `chrome.tabs.update` to the real URL once attached — the
// same two-step shape `context.newPage()` + `.goto()` already gets for free. Applied only in this
// test process; `src/entrypoints/background.ts`'s real one-step `chrome.tabs.create` is untouched.
async function patchBrowseTabCreationForCdpAttach(sw: Awaited<ReturnType<typeof serviceWorker>>) {
  await sw.evaluate(() => {
    const original = chrome.tabs.create.bind(chrome.tabs);
    chrome.tabs.create = (async (props: chrome.tabs.CreateProperties) => {
      if (!props.url || props.url === 'about:blank') return original(props);
      const blank = await original({ ...props, url: 'about:blank' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (blank.id !== undefined) await chrome.tabs.update(blank.id, { url: props.url });
      return blank;
    }) as typeof chrome.tabs.create;
  });
}

test('copy: browses a reference fixture, then applies and durably records a matching edit on the users own page', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context, {
    own:
      '<!doctype html><html><body><h1 id="hero">My Hero</h1>' +
      '<button id="cta" data-testid="cta">Buy now</button></body></html>',
    reference:
      '<!doctype html><html><body style="background-color:#76b900">' +
      '<h1>Reference Co</h1><button style="background-color:#76b900">Shop</button></body></html>',
  });

  const requests = await stubChat(context, [
    toolCallStream('call-browse', 'browse', { url: `${FIXTURE_PREFIX}reference` }),
    toolCallStream('call-set-style', 'setStyle', {
      selector: '#cta',
      props: { 'background-color': '#76b900' },
    }),
    textStream('Recolored your CTA to match the reference palette.'),
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);
  await patchBrowseTabCreationForCdpAttach(await serviceWorker(context));

  const ownPage = await context.newPage();
  await ownPage.goto(`${FIXTURE_PREFIX}own`);
  await ownPage.bringToFront(); // background.ts targets the active tab of the last-focused window

  await sendUserMessage(panel, 'Copy the reference site colors onto my CTA', 'copy');

  // Three model calls: browse -> setStyle -> final summary. Proves the full multi-step turn ran.
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(3);

  // The design read the SW's background-tab browse produced reached the model as the browse
  // tool's JSON result (mirrors browse-loop.test.ts's `browseResultShownToModel`, at the wire).
  const afterBrowse = requests[1]?.messages.at(-1);
  expect(afterBrowse?.role).toBe('tool');
  expect(String(afterBrowse?.content)).toContain('"ok":true');
  expect(String(afterBrowse?.content)).toContain('#76b900');

  // The setStyle result the model saw confirms the mutation applied on the OWN tab, not the
  // (already-closed) reference tab.
  const afterSetStyle = requests[2]?.messages.at(-1);
  expect(afterSetStyle?.role).toBe('tool');
  expect(String(afterSetStyle?.content)).toContain('"ok":true');

  // The mutation actually landed on the live page over the real content-script bus.
  await expect(ownPage.locator('#cta')).toHaveCSS('background-color', 'rgb(118, 185, 0)');

  // "Recorded" (plan 06 step 5): the change is reversible through the real recorder — exactly
  // like dom-tools.spec.ts's setStyle/undo pair — so it was durably captured, not just painted.
  const sw = await serviceWorker(context);
  const tabId = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === url)?.id;
  }, `${FIXTURE_PREFIX}own`);
  if (tabId === undefined) throw new Error('own fixture tab not found');
  const undone = (await sw.evaluate(
    ({ tabId }) => chrome.tabs.sendMessage(tabId, { type: 'undo' }),
    { tabId },
  )) as { ok: boolean };
  expect(undone.ok).toBe(true);
  await expect(ownPage.locator('#cta')).not.toHaveCSS('background-color', 'rgb(118, 185, 0)');
});

test('debug: a seeded a11y bug is scanned by the diagnostics tool and reaches the model as evidence', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  // A real, common bug: an icon-only button with no accessible name — `scanA11y`'s `control-name`
  // rule (src/dom/diagnostics-collector.ts), reading the shared DOM directly, so (unlike
  // console/exception/fetch hooking — see file header) it reliably observes a page-authored bug.
  await stubFixtures(context, {
    debug:
      '<!doctype html><html lang="en"><body><h1>Debug Me</h1>' +
      '<button class="icon-btn"><svg width="16" height="16"></svg></button></body></html>',
  });

  const requests = await stubChat(context, [
    toolCallStream('call-diagnostics', 'diagnostics', { action: 'scan' }),
    textStream(
      'Root cause: the icon-only button has no accessible name, so assistive tech announces ' +
        'nothing for it. Proposed fix: add an aria-label describing the action.',
    ),
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);

  const debugPage = await context.newPage();
  await debugPage.goto(`${FIXTURE_PREFIX}debug`);
  await debugPage.bringToFront();

  await sendUserMessage(panel, 'Debug the accessibility of this page', 'debug');

  // Two model calls: diagnostics(scan) -> the proposed-fix summary.
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(2);

  // The scanned signal reached the model as the diagnostics tool's JSON result — a real
  // `control-name` a11y finding for the seeded button, not a lint-style guess.
  const afterScan = requests[1]?.messages.at(-1);
  expect(afterScan?.role).toBe('tool');
  const shown = String(afterScan?.content);
  expect(shown).toContain('"ok":true');
  expect(shown).toContain('"kind":"a11y"');
  expect(shown).toContain('"rule":"control-name"');
  expect(shown).toContain('no accessible name');
});
