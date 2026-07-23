import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// E2E: the Diff tab (slice 10 / issue #10) driven against a loaded, real Chromium — same harness
// as chat-streaming.spec.ts (only the model's HTTP replies are canned; the panel, the SW's
// durable per-tab ChangesetStore, and the changeset-* curation RPCs all run for real). Proves the
// changeset review UI end to end: a stubbed turn's `recordEdit` lands as a rendered edit row
// (selector, intent, per-property before/after table, live count), and the curation bar —
// per-edit remove / undo / redo / clear — walks the DURABLE shippable record (never the page).
// The first test is the acceptance evidence for issue #22 criterion 4 ("diff review shows it").

const BASE_URL = 'https://openrouter.ai/api/v1';
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture-10/';

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
// (mirrors chat-streaming.spec.ts's `stubProvider`). A turn may be an async factory instead of a
// static body — the controls-disabled-while-streaming test uses one to hold a turn open on a gate
// the test releases, so "mid-stream" is deterministic without a fixed sleep.
type Turn = string | (() => Promise<string>);

function stubProvider(context: BrowserContext, turns: Turn[]): { requests: ChatRequestBody[] } {
  const requests: ChatRequestBody[] = [];
  void context.route(`${BASE_URL}/chat/completions`, async (route) => {
    const index = requests.length;
    requests.push(JSON.parse(route.request().postData() ?? '{}') as ChatRequestBody);
    const turn = turns[index];
    const body =
      typeof turn === 'function' ? await turn() : (turn ?? textStream('(unexpected extra turn)'));
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  return { requests };
}

async function configureProvider(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-key').fill('sk-or-test-10');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model option')).toHaveText(['Test Vision']);
  await page.locator('#dz-model').selectOption('test/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');
}

// Start flips the session out of idle so ChatPanel mounts (mirrors chat-streaming.spec.ts).
async function startSession(panel: Page): Promise<void> {
  const toggle = panel.locator('.dz-readiness__toggle');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(panel.locator('.dz-readiness__pill')).toHaveText(/Running…/);
  await panel.getByRole('button', { name: 'Chat' }).click();
}

async function sendInstruction(panel: Page, text: string): Promise<void> {
  await panel.getByPlaceholder('Tell the agent what to change…').fill(text);
  // exact: once a thread exists the ShipBar's "Send to…" also matches a substring "Send".
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
}

// The fixture page the session attaches to. recordEdit is SW-side (it folds into the durable
// changeset; nothing touches the live DOM), so the elements only give the changeset a real URL.
const OWN_PAGE =
  '<!doctype html><html><body>' +
  '<h1 id="hero-title">My Hero</h1>' +
  '<button id="cta">Buy now</button>' +
  '</body></html>';

// A second, session-less page for the tab-switch retarget test.
const OTHER_PAGE = '<!doctype html><html><body><h1>Elsewhere</h1></body></html>';

// Two distinctive edits. Args must satisfy the `Edit` schema (src/shared/changeset.ts) — the
// recordEdit tool's inputSchema IS that schema (src/agent/tools/session.ts). CTA_EDIT is fragile
// so the Diff tab's fragile-selector badge has a pin.
const CTA_EDIT = {
  intent: 'Recolor the CTA to the brand accent',
  selector: { value: '#cta', strategy: 'id', fragile: true },
  changes: [{ prop: 'background-color', before: '#e5e7eb', after: '#22c55e' }],
  frameworkHints: [],
};

const HERO_EDIT = {
  intent: 'Enlarge the hero headline',
  selector: { value: '#hero-title', strategy: 'id' },
  changes: [{ prop: 'font-size', before: '16px', after: '32px' }],
  frameworkHints: [],
};

test('diff review shows a recorded edit (#22)', async ({ context, openExtensionPage }) => {
  await stubModels(context);
  await stubFixtures(context, { own: OWN_PAGE });
  const { requests } = stubProvider(context, [
    toolCallStream('call-record', 'recordEdit', CTA_EDIT),
    textStream('Recolored your CTA to the brand accent green.'),
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);
  await startSession(panel);

  const ownPage = await context.newPage();
  await ownPage.goto(`${FIXTURE_PREFIX}own`);
  await ownPage.bringToFront();

  await sendInstruction(panel, 'Recolor the CTA and record it');
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(2);
  await expect(panel.locator('.dz-message--assistant').last()).toContainText(
    'Recolored your CTA to the brand accent green.',
  );

  // The Diff tab (icon-only, aria-labeled "Diff") renders the durable record: one row with the
  // selector chip (`describeSelector` → "value · strategy"), the intent, the per-property
  // before/after table, and the live count.
  await panel.getByRole('button', { name: 'Diff' }).click();

  await expect(panel.locator('.dz-diff__count')).toHaveText('1 edit');
  const item = panel.locator('.dz-diff__item');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.dz-diff__selector')).toHaveText('#cta · id');
  await expect(item.locator('.dz-diff__fragile')).toContainText('Fragile selector');
  await expect(item.locator('.dz-diff__intent')).toHaveText('Recolor the CTA to the brand accent');

  const change = item.locator('.dz-diff__changes tbody tr');
  await expect(change).toHaveCount(1);
  await expect(change.locator('.dz-diff__prop')).toHaveText('background-color');
  await expect(change.locator('.dz-diff__before')).toHaveText('#e5e7eb');
  await expect(change.locator('.dz-diff__after')).toHaveText('#22c55e');
});

test('curation round-trip: per-edit remove forks history, then undo/redo/clear walk the durable record', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context, { own: OWN_PAGE });
  // One user message, two sequential recordEdit tool calls (the loop re-requests after each).
  const { requests } = stubProvider(context, [
    toolCallStream('call-hero', 'recordEdit', HERO_EDIT),
    toolCallStream('call-cta', 'recordEdit', CTA_EDIT),
    textStream('Both edits recorded.'),
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);
  await startSession(panel);

  const ownPage = await context.newPage();
  await ownPage.goto(`${FIXTURE_PREFIX}own`);
  await ownPage.bringToFront();

  await sendInstruction(panel, 'Enlarge the hero and recolor the CTA');
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(3);
  await expect(panel.locator('.dz-message--assistant').last()).toContainText(
    'Both edits recorded.',
  );

  await panel.getByRole('button', { name: 'Diff' }).click();
  const items = panel.locator('.dz-diff__item');
  await expect(items).toHaveCount(2);
  await expect(panel.locator('.dz-diff__count')).toHaveText('2 edits');
  await expect(items.nth(0).locator('.dz-diff__selector')).toHaveText('#hero-title · id');
  await expect(items.nth(1).locator('.dz-diff__selector')).toHaveText('#cta · id');

  // Remove the first edit. removeAt FORKS history (src/changeset/store.ts): the redo tail is
  // cleared, so the hero edit is gone for good — a following undo pops the SURVIVING CTA edit,
  // it never brings the removed one back. The sequence asserted below is that exact contract:
  // [hero, cta] → remove(0) → [cta] → undo → [] → redo → [cta] → clear → [].
  await items.nth(0).getByRole('button', { name: 'Remove this edit' }).click();
  await expect(items).toHaveCount(1);
  await expect(panel.locator('.dz-diff__count')).toHaveText('1 edit');
  await expect(items.nth(0).locator('.dz-diff__selector')).toHaveText('#cta · id');
  await expect(items.nth(0).locator('.dz-diff__intent')).toHaveText(
    'Recolor the CTA to the brand accent',
  );

  await panel.getByRole('button', { name: 'Undo last edit' }).click();
  await expect(items).toHaveCount(0);
  await expect(panel.locator('.dz-diff__count')).toHaveText('0 edits');
  await expect(panel.locator('.dz-diff__empty')).toHaveText(
    'No edits yet — recorded changes show up here as you design.',
  );

  await panel.getByRole('button', { name: 'Redo edit' }).click();
  await expect(items).toHaveCount(1);
  await expect(panel.locator('.dz-diff__count')).toHaveText('1 edit');
  await expect(items.nth(0).locator('.dz-diff__selector')).toHaveText('#cta · id');

  await panel.getByRole('button', { name: 'Clear session' }).click();
  await expect(items).toHaveCount(0);
  await expect(panel.locator('.dz-diff__count')).toHaveText('0 edits');
  await expect(panel.locator('.dz-diff__empty')).toBeVisible();
  // Wiped record + wiped redo tail: every mutating control is disabled.
  await expect(panel.getByRole('button', { name: 'Undo last edit' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Redo edit' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Clear session' })).toBeDisabled();
});

test('diff controls disable while a turn streams and re-enable when it lands', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context, { own: OWN_PAGE });

  // The second message's turn is gated: the provider reply is withheld until the test releases
  // it, so the mid-stream assertions below can't race the turn finishing.
  let releaseTurn: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const { requests } = stubProvider(context, [
    toolCallStream('call-record', 'recordEdit', CTA_EDIT),
    textStream('Recolored your CTA.'),
    async () => {
      await gate;
      return textStream('Follow-up done.');
    },
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);
  await startSession(panel);

  const ownPage = await context.newPage();
  await ownPage.goto(`${FIXTURE_PREFIX}own`);
  await ownPage.bringToFront();

  await sendInstruction(panel, 'Recolor the CTA and record it');
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(2);
  await expect(panel.locator('.dz-message--assistant').last()).toContainText('Recolored your CTA.');

  // No turn in flight: the recorded edit's controls are live.
  await panel.getByRole('button', { name: 'Diff' }).click();
  const remove = panel
    .locator('.dz-diff__item')
    .first()
    .getByRole('button', { name: 'Remove this edit' });
  await expect(remove).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Undo last edit' })).toBeEnabled();

  // A second instruction starts a turn that parks on the gate (composer swaps Send→Stop).
  await panel.getByRole('button', { name: 'Chat' }).click();
  await sendInstruction(panel, 'Tweak it again');
  await expect(panel.locator('.dz-composer').getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(3);

  // busy = streaming || curating (ChangesetPreview): every mutating control is disabled while
  // the turn owns the store — the SW would reject a mid-turn op anyway.
  await panel.getByRole('button', { name: 'Diff' }).click();
  await expect(remove).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Undo last edit' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Redo edit' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Clear session' })).toBeDisabled();

  // The turn lands: controls re-enable against the still-intact record.
  releaseTurn();
  await expect(remove).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Undo last edit' })).toBeEnabled();
  await expect(panel.locator('.dz-diff__count')).toHaveText('1 edit');
});

test('the diff view follows tab switches — never curates a tab the user is not looking at (#141)', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context, { own: OWN_PAGE, other: OTHER_PAGE });
  const { requests } = stubProvider(context, [
    toolCallStream('call-record', 'recordEdit', CTA_EDIT),
    textStream('Recolored your CTA.'),
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);
  await startSession(panel);

  const ownPage = await context.newPage();
  await ownPage.goto(`${FIXTURE_PREFIX}own`);
  await ownPage.bringToFront();

  await sendInstruction(panel, 'Recolor the CTA and record it');
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(2);

  await panel.getByRole('button', { name: 'Diff' }).click();
  await expect(panel.locator('.dz-diff__count')).toHaveText('1 edit');

  // Switch to a second tab with no session: the view retargets to THAT tab's (empty) record —
  // a mutator can therefore only ever land on the record the user is actually seeing (the SW
  // additionally drift-rejects a forTabId mismatch; integration covers that leg).
  const otherPage = await context.newPage();
  await otherPage.goto(`${FIXTURE_PREFIX}other`);
  await otherPage.bringToFront();
  await expect(panel.locator('.dz-diff__count')).toHaveText('0 edits');
  await expect(panel.locator('.dz-diff__empty')).toBeVisible();

  // Back on the first tab its record is intact.
  await ownPage.bringToFront();
  await expect(panel.locator('.dz-diff__count')).toHaveText('1 edit');
  await expect(panel.locator('.dz-diff__item').locator('.dz-diff__selector')).toHaveText(
    '#cta · id',
  );
});

test('a turn running on another tab never bleeds phantom rows into the diff view (#141)', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context, { own: OWN_PAGE, other: OTHER_PAGE });

  // The recordEdit turn is gated: the provider reply (and with it the edit-recorded push) is
  // withheld until the test releases it — so the push lands WHILE the panel views the other tab.
  let releaseTurn: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const { requests } = stubProvider(context, [
    async () => {
      await gate;
      return toolCallStream('call-record', 'recordEdit', CTA_EDIT);
    },
    textStream('Recolored your CTA.'),
  ]);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);
  await startSession(panel);

  const ownPage = await context.newPage();
  await ownPage.goto(`${FIXTURE_PREFIX}own`);
  await ownPage.bringToFront();

  await sendInstruction(panel, 'Recolor the CTA and record it');
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(1);

  // Mid-turn, switch to a session-less tab: the view retargets to its (empty) record.
  const otherPage = await context.newPage();
  await otherPage.goto(`${FIXTURE_PREFIX}other`);
  await otherPage.bringToFront();
  await panel.getByRole('button', { name: 'Diff' }).click();
  await expect(panel.locator('.dz-diff__count')).toHaveText('0 edits');

  // The turn's edit-recorded lands — stamped for the FIRST tab, so THIS view drops it. Request 2
  // starting proves the recordEdit tool call already executed (and its push was emitted); the
  // turn-done refresh only re-pulls the OTHER tab's empty record, so the count must stay 0.
  releaseTurn();
  await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(2);
  await expect(panel.locator('.dz-diff__count')).toHaveText('0 edits');
  await expect(panel.locator('.dz-diff__item')).toHaveCount(0);

  // Back on the first tab, the edit the turn recorded is really there.
  await ownPage.bringToFront();
  await expect(panel.locator('.dz-diff__count')).toHaveText('1 edit');
  await expect(panel.locator('.dz-diff__item').locator('.dz-diff__selector')).toHaveText(
    '#cta · id',
  );
});
