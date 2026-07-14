import type { BrowserContext, Page } from '@playwright/test';
import { renderIdentityTokens } from '@/changeset/report-md';
import type { IdentityResult, ToolResult } from '@/shared/messages';
import { expect, test } from './fixtures';

// E2E: the slice-14 copy spine (`14-describe-identity.md`) driven against a loaded, real Chromium —
// "copy a reference fixture → extract its identity → apply it to the user's own page → render the
// identity as a report tokens table". Same composer-stub-RPC approach as copy-debug.spec.ts (the
// composer itself lands in a later slice): `sendUserMessage` fires the already-real, already-wired
// `user-message` handler directly. Unlike copy-debug.spec.ts (which copies via the `browse` tool's
// coarse `DesignRead`), this drives the slice-14 `extractIdentity` tool directly against a REAL
// second tab's real DOM (no mock of our own extraction code) — proving the full round trip: a real
// `IdentityResult` reaches the model, the model's follow-up `setStyle` paints the extracted accent
// onto the user's own live page, and that same `IdentityResult` renders as the Markdown tokens table
// `renderIdentityTokens` (src/changeset/report-md.ts, the piece the future report/handoff assembly
// composes into its brief) is built for.

const BASE_URL = 'https://openrouter.ai/api/v1';
// Distinct from dom-tools.spec.ts's / copy-debug.spec.ts's fixture prefixes so no two specs' routes
// ever overlap even if Playwright shares a context.
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture-14/';

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
  await page.locator('#dz-key').fill('sk-or-test-14');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model option')).toHaveText(['Test Vision']);
  await page.locator('#dz-model').selectOption('test/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');
}

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

async function tabIdFor(context: BrowserContext, url: string): Promise<number> {
  const sw = await serviceWorker(context);
  const id = await sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === u)?.id;
  }, url);
  if (id === undefined) throw new Error(`tab not found for ${url}`);
  return id;
}

// The last tool-result message the model was shown for one request, parsed back into its typed
// ToolResult — the same shape browse-loop.test.ts's `browseResultShownToModel` asserts against, at
// the wire instead of a mock.
function lastToolResult(body: ChatRequestBody | undefined): ToolResult {
  const last = body?.messages.at(-1);
  if (last?.role !== 'tool') throw new Error('expected the last message to be a tool result');
  return JSON.parse(String(last.content)) as ToolResult;
}

test('copy: extracts a real reference identity, applies its accent to the users own page, and the identity renders as a tokens table', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context, {
    own: '<!doctype html><html><body><h1 id="hero">My Hero</h1><button id="cta">Buy now</button></body></html>',
    reference:
      '<!doctype html><html><body style="background-color:#ffffff">' +
      '<h1 style="color:#101014">Reference Co</h1>' +
      '<button style="background-color:#ff3366;color:#ffffff">Shop</button></body></html>',
  });

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);

  // Open the reference in a real background tab (never activated) and the user's own page in the
  // active tab — `resolveTargetTab` (background.ts) targets the active tab, so the turn runs
  // against `own` while `reference` is addressable by tabId, exactly like a second real tab would be.
  const referencePage = await context.newPage();
  await referencePage.goto(`${FIXTURE_PREFIX}reference`);
  const referenceTabId = await tabIdFor(context, `${FIXTURE_PREFIX}reference`);

  const ownPage = await context.newPage();
  await ownPage.goto(`${FIXTURE_PREFIX}own`);
  await ownPage.bringToFront();

  const requests = await stubChat(context, [
    toolCallStream('call-extract', 'extractIdentity', { tabId: referenceTabId }),
    toolCallStream('call-set-style', 'setStyle', {
      selector: '#cta',
      props: { 'background-color': '#ff3366' },
    }),
    textStream('Applied the reference brand — tokens in the report below.'),
  ]);

  await sendUserMessage(panel, 'Copy the reference identity onto my CTA', 'copy');

  // Three model calls: extractIdentity -> setStyle -> final summary.
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(3);

  // The REAL reference identity (extracted by src/dom/identity.ts against the live reference tab,
  // not a mock) reached the model as extractIdentity's JSON result: the button fill role-tagged accent.
  const extracted = lastToolResult(requests[1]);
  expect(extracted.ok).toBe(true);
  const identity = extracted.data as IdentityResult;
  expect(identity.palette).toContainEqual({ hex: '#ff3366', role: 'accent', count: 1 });

  // The setStyle result confirms the mutation applied on the OWN tab (not the reference tab).
  const applied = lastToolResult(requests[2]);
  expect(applied.ok).toBe(true);

  // The mutation actually landed on the live page over the real content-script bus.
  await expect(ownPage.locator('#cta')).toHaveCSS('background-color', 'rgb(255, 51, 102)');

  // Reversible: a real recorder event backs the mutation, exactly like copy-debug.spec.ts's pair.
  const sw = await serviceWorker(context);
  const ownTabId = await tabIdFor(context, `${FIXTURE_PREFIX}own`);
  const undone = (await sw.evaluate(
    ({ tabId }) => chrome.tabs.sendMessage(tabId, { type: 'undo' }),
    { tabId: ownTabId },
  )) as { ok: boolean };
  expect(undone.ok).toBe(true);
  await expect(ownPage.locator('#cta')).not.toHaveCSS('background-color', 'rgb(255, 51, 102)');

  // The identity the agent actually extracted renders as the report's tokens table (the hand-off
  // this slice feeds — full report assembly is a later slice) — "tokens, not raw hex" end to end.
  const md = renderIdentityTokens(identity);
  expect(md).toContain('### Color tokens');
  expect(md).toContain('| Accent | `#ff3366` | 1 |');
});
