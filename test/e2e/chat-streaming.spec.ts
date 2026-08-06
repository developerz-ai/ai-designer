import type { BrowserContext, Page } from '@playwright/test';
import { expect, openRoom, stubAuthProbe, test } from './fixtures';

// E2E: the Leo-style chat UI (slice 11) driven against a loaded, real Chromium — the composer,
// context pin, and Ship foot are all real now (PR15's ChatPanel rebuild), unlike
// handoff.spec.ts/copy-debug.spec.ts, which had to send `user-message` straight to the SW because
// the panel was still a stub. This spec instead drives the actual UI end to end: Start -> pick an
// element on the page (Cursor-style context pin) -> type an instruction -> watch the assistant
// stream in with a tool-call chip -> Ship/Download become available once the turn lands an edit.
// Only the model's HTTP replies are canned (mirrors handoff.spec.ts's `stubProvider`); everything
// downstream — the real content-script picker, the real cross-world tool dispatch, the real Solid
// render — runs for real.

const BASE_URL = 'https://openrouter.ai/api/v1';
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture-11/';

async function stubModels(context: BrowserContext): Promise<void> {
  await context.route(`${BASE_URL}/models`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'test/vision', name: 'Test Vision' }] }),
    }),
  );
  await stubAuthProbe(context, BASE_URL);
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
  stream?: boolean;
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

// Every `/chat/completions` POST is one streaming tool-loop turn, served in order from `turns[]`
// — mirrors handoff.spec.ts's `stubProvider` (this spec never triggers the report pass, so no
// non-streaming branch is needed).
function stubProvider(context: BrowserContext, turns: string[]): { requests: ChatRequestBody[] } {
  const requests: ChatRequestBody[] = [];
  void context.route(`${BASE_URL}/chat/completions`, async (route) => {
    const index = requests.length;
    requests.push(JSON.parse(route.request().postData() ?? '{}') as ChatRequestBody);
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: turns[index] ?? textStream('(unexpected extra turn)'),
    });
  });
  return { requests };
}

async function configureProvider(page: Page): Promise<void> {
  await openRoom(page, 'Settings');
  await page.locator('#dz-key').fill('sk-or-test-11');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model')).toHaveValue('test/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');
}

// No `data-testid` — `pickUnique` (src/dom/selector.ts) ranks data-attr above id, so a bare
// `id` here is what makes the picker resolve `#cta` (the strategy this spec asserts on the
// context chip) rather than a data-attr candidate.
const OWN_PAGE =
  '<!doctype html><html><body>' +
  '<h1 id="hero">My Hero</h1>' +
  '<button id="cta">Buy now</button>' +
  '</body></html>';

const RECORD_EDIT_ARGS = {
  intent: 'Recolor the CTA to the brand accent',
  selector: { value: '#cta', strategy: 'id' },
  changes: [{ prop: 'background-color', before: '#e5e7eb', after: '#22c55e' }],
  frameworkHints: [],
};

test('after Start: pick an element, send an instruction, watch it stream with a tool chip, Ship/Download appear', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context, { own: OWN_PAGE });
  const { requests } = stubProvider(context, [
    toolCallStream('call-record', 'recordEdit', RECORD_EDIT_ARGS),
    textStream('Recolored your CTA to the brand accent green.'),
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);

  // Start flips the session out of idle; ChatPanel replaces the pre-Start empty state
  // (mirrors readiness.spec.ts).
  const toggle = panel.locator('.dz-readiness__toggle');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(panel.locator('.dz-readiness__pill')).toHaveText(/Running…/);
  await openRoom(panel, 'Chat');

  // Before any turn has run, the empty state (with its suggestion chips) stands in for Thread.
  await expect(panel.getByPlaceholder('Tell the agent what to change…')).toBeVisible();

  const ownPage = await context.newPage();
  await ownPage.goto(`${FIXTURE_PREFIX}own`);
  await ownPage.bringToFront();

  // Cursor-style context pin: attach an element from the live page to the conversation.
  await panel.locator('.dz-composer__attach').click();
  await expect(panel.locator('.dz-context-chip')).toHaveText(/Picking element…/);
  await ownPage.locator('#cta').click();

  // The chip's PRIMARY label is now the human name for the element; the raw selector + strategy
  // moved to its `title` (and to the inset line the label reveals on click).
  await expect(panel.locator('.dz-context-chip__label')).toHaveText('#cta');
  await expect(panel.locator('.dz-context-chip__label')).toHaveAttribute('title', /#cta · id/);

  // Send the instruction — the real Composer/chat store this time, not a raw RPC.
  await panel
    .getByPlaceholder('Tell the agent what to change…')
    .fill('Recolor the CTA and record it');
  await panel.getByRole('button', { name: 'Send' }).click();

  // Streaming: the composer disables send and swaps to Stop while a turn is in flight. Scoped to
  // `.dz-composer` — the header's session Start/Stop toggle shares the same accessible name.
  await expect(panel.locator('.dz-composer').getByRole('button', { name: 'Stop' })).toBeVisible();

  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(2);

  // #165 S6/P1 — the signature interaction, proven end to end against a real provider request.
  // The picker resolves `#cta` in the content world, the panel echoes it back on
  // `UserMessage.selector`, and the SW grounds the instruction (src/agent/focus-context.ts)
  // BEFORE the model sees it. Previously the selector reached the panel for display only and
  // stopped there, so the model got the bare text and had to guess what "this" was.
  const sentUser = requests[0]?.messages.filter((m) => m.role === 'user') ?? [];
  // Unescape so the assertion reads as the text the model actually sees, not its JSON encoding.
  const groundedText = sentUser
    .map((m) => JSON.stringify(m.content))
    .join('\n')
    .replaceAll('\\"', '"');
  expect(groundedText).toContain('Recolor the CTA and record it');
  // Phrased as a fact about the referent, not an instruction competing with the user's request.
  expect(groundedText).toContain('"this"/"it" refers to `#cta` (id)');

  // Thread renders the user instruction, the tool-call chip, and the assistant's final text.
  // Scoped to __text, not the whole turn: each turn now carries a visually-hidden speaker
  // label ("You" / "Agent") so a screen reader can tell them apart, and Playwright's
  // toHaveText reads textContent — which includes hidden text.
  await expect(panel.locator('.dz-message--user .dz-message__text').last()).toHaveText(
    'Recolor the CTA and record it',
  );
  // A turn's tool calls collapse behind a group header (a run is routinely 6-12 calls), so the
  // successful ones are behind one click. The header itself is the always-visible summary.
  await expect(panel.locator('.dz-tool-call-list__count')).toContainText('action');
  await panel.locator('.dz-tool-call-list__header').click();
  const toolChip = panel.locator('.dz-tool-chip__name', { hasText: 'recordEdit' });
  await expect(toolChip).toBeVisible();
  await expect(panel.locator('.dz-tool-chip')).toHaveClass(/dz-tool-chip--done/);
  await expect(panel.locator('.dz-message--assistant').last()).toContainText(
    'Recolored your CTA to the brand accent green.',
  );

  // The context pin survives the turn (still shows the picked element, not cleared by send()).
  await expect(panel.locator('.dz-context-chip__label')).toHaveText('#cta');

  // A thread now exists -> Ship foot is mounted.
  await expect(panel.getByRole('button', { name: 'Ship' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Download brief' })).toBeVisible();
});
