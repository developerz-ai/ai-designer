// Web Store listing screenshots (#26) — standalone capture script, NOT a Playwright test.
// Runs the REAL built extension (`.output/chrome-mv3`) in a real Chromium persistent context
// against the local demo page, with only the model's HTTP canned (the same vocabulary as
// test/e2e/chat-streaming.spec.ts + overlay.spec.ts + diff-review.spec.ts). No model key needed.
//
// Usage (from the repo root): `bun run build` once, then `bun store/screenshots/capture.ts`.
// Produces five 1280x800 PNGs in store/screenshots/:
//   shot-1-chat-turn.png      panel: user message + tool chips + assistant reply, turn complete
//   shot-2-live-highlight.png page: mutation-highlight overlay on the edited CTA
//   shot-3-diff-review.png    panel: Diff tab with the before/after changeset rows
//   shot-4-picker.png         page: element-picker hover highlight + label on the CTA
//   shot-5-ship.png           panel: Ship / Download brief foot after the edit landed
//
// One coherent story across shots 1-3+5: pin the demo page's start-button CTA, ask for an
// emerald background, watch setStyle land live, add a glow in a follow-up, review the two
// recorded edits, ship the set.
//
// Sequencing notes (learned from the specs):
// - The picker shot runs BEFORE the turn: pinning context is the natural first step, and the
//   picker's hover chrome only exists while picking (Escape ends the pick afterwards).
// - The turn's SECOND model request (recordEdit) is gated: recordEdit's selector is an object,
//   so classifyTool (src/shared/overlay-step.ts) finds no string selector and the overlay step
//   HIDES the mark (src/dom/overlay.ts highlight() -> hideMark()). Shot 2 is captured while the
//   recordEdit request is parked on the gate; the gate then releases and the turn completes.
// - The recordEdit selector value must exactly match the content script's pickUnique result
//   (`[data-testid="cta-start"]`) so it drains the pending recorder event — otherwise the
//   turn-end auto-finalize (background.ts #9) adds a second, "Auto-recorded" Diff row.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type BrowserContext, chromium, type Locator, type Page } from 'playwright';

const ROOT = process.cwd();
const EXT_PATH = path.resolve(ROOT, '.output/chrome-mv3');
const OUT_DIR = path.resolve(ROOT, 'store/screenshots');
const DEMO_URL = 'https://demo.local/';
const OR_API = 'https://openrouter.ai/api/v1';
const VIEWPORT = { width: 1280, height: 800 };

const CTA = '[data-testid="cta-start"]';
const EMERALD = '#059669'; // emerald-600 — also the demo page's own "up" accent
const GLOW = '0 10px 30px rgba(5, 150, 105, 0.4)';
const USER_MESSAGE = 'Make the start button pop with an emerald background';
const ASSISTANT_REPLY =
  'Done — the "Start free trial" button now pops in emerald (#059669). The edit is live on ' +
  'the page and recorded in the changeset: review it in the Diff tab, undo it, or Ship it ' +
  "when you're happy.";
// Second turn: keeps shots 3+5 from duplicating shot 1 — a follow-up on the same CTA (the demo
// page's only hooked element) gives the Diff a second row and the thread a second exchange.
const FOLLOW_UP_MESSAGE = 'Give it a soft emerald glow too';
const FOLLOW_UP_REPLY =
  "Added a soft emerald glow under the button. That's 2 edits on the changeset — the Diff " +
  'tab shows both with before/after values, and Ship hands the set over as one brief.';
const MODEL_ID = 'openai/gpt-5';
const MODEL_NAME = 'GPT-5';

// --- canned model HTTP (mirrors test/e2e/chat-streaming.spec.ts) --------------------------

function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const payload = {
    id: 'store-shot-chunk',
    created: 0,
    model: MODEL_ID,
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

// A turn may be an async factory — the recordEdit turn parks on a gate until shot 2 is taken
// (mirrors diff-review.spec.ts's controls-disabled-while-streaming gate).
type Turn = string | (() => Promise<string>);

function stubModels(context: BrowserContext): Promise<void> {
  return context.route(`${OR_API}/models`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: MODEL_ID, name: MODEL_NAME }] }),
    }),
  );
}

function stubProvider(context: BrowserContext, turns: Turn[]): { requests: unknown[] } {
  const requests: unknown[] = [];
  void context.route(`${OR_API}/chat/completions`, async (route) => {
    const index = requests.length;
    requests.push(JSON.parse(route.request().postData() ?? '{}'));
    const turn = turns[index];
    const body =
      typeof turn === 'function' ? await turn() : (turn ?? textStream('(unexpected extra turn)'));
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  return { requests };
}

function stubDemoPage(context: BrowserContext): Promise<void> {
  const html = readFileSync(path.join(OUT_DIR, 'demo-page.html'), 'utf8');
  return context.route(`${DEMO_URL}**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
}

// --- deterministic waits (no test-runner `expect` in a standalone script) -----------------

async function waitFor(
  cond: () => Promise<boolean>,
  what: string,
  timeout = 20_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitText(locator: Locator, re: RegExp, what: string): Promise<void> {
  await waitFor(async () => re.test((await locator.textContent()) ?? ''), what);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file });
  console.log(`captured ${name}`);
}

// --- panel flows (mirror the e2e specs) -----------------------------------------------------

async function configureProvider(panel: Page): Promise<void> {
  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.locator('#dz-key').fill('sk-or-store-shots');
  await panel.getByRole('button', { name: 'Refresh' }).click();
  await waitText(panel.locator('#dz-model option'), new RegExp(MODEL_NAME), 'model list');
  await panel.locator('#dz-model').selectOption(MODEL_ID);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await waitText(
    panel.locator('.dz-settings__status'),
    /Provider saved and reachable\./,
    'provider saved',
  );
}

async function startSession(panel: Page): Promise<void> {
  const toggle = panel.locator('.dz-readiness__toggle');
  await toggle.waitFor({ state: 'visible' });
  await waitFor(async () => await toggle.isEnabled(), 'readiness toggle enabled');
  await toggle.click();
  await waitText(panel.locator('.dz-readiness__pill'), /Running…/, 'session running');
  await panel.getByRole('button', { name: 'Chat' }).click();
}

// Opt into the on-page agent-decision overlay (slice 09) so shot 2 has the mutation highlight,
// then close the dropdown so it isn't in any shot.
async function enableOnPageOverlay(panel: Page): Promise<void> {
  await panel.locator('.dz-readiness__pill').click();
  const overlaySwitch = panel.getByRole('switch');
  await overlaySwitch.waitFor({ state: 'visible' });
  await overlaySwitch.click();
  await waitFor(
    async () => (await overlaySwitch.getAttribute('aria-checked')) === 'true',
    'overlay switch on',
  );
  await panel.locator('.dz-readiness__pill').click();
  await overlaySwitch.waitFor({ state: 'hidden' });
}

// --- main -------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(EXT_PATH)) {
    throw new Error(`Built extension not found at ${EXT_PATH} — run \`bun run build\` first.`);
  }

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });

  try {
    await stubModels(context);
    await stubDemoPage(context);

    // The recordEdit turn parks here until shot 2 is captured (see the header note).
    let releaseRecord = (): void => {};
    const recordGate = new Promise<void>((resolve) => {
      releaseRecord = resolve;
    });
    const { requests } = stubProvider(context, [
      toolCallStream('call-setstyle', 'setStyle', {
        selector: CTA,
        props: { 'background-color': EMERALD },
      }),
      async () => {
        await recordGate;
        return toolCallStream('call-record', 'recordEdit', {
          intent: USER_MESSAGE,
          selector: { value: CTA, strategy: 'data-attr' },
          changes: [{ prop: 'background-color', before: '#4f46e5', after: EMERALD }],
          frameworkHints: [],
        });
      },
      textStream(ASSISTANT_REPLY),
      // Follow-up turn (ungated): same CTA, one more recorded edit.
      toolCallStream('call-glow', 'setStyle', {
        selector: CTA,
        props: { 'box-shadow': GLOW },
      }),
      toolCallStream('call-record-glow', 'recordEdit', {
        intent: FOLLOW_UP_MESSAGE,
        selector: { value: CTA, strategy: 'data-attr' },
        changes: [{ prop: 'box-shadow', before: 'none', after: GLOW }],
        frameworkHints: [],
      }),
      textStream(FOLLOW_UP_REPLY),
    ]);

    // Extension id = host of the service-worker URL; seed onboarding dismissed BEFORE opening
    // the panel so the first-run modal never covers the tabs (mirrors fixtures.ts).
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(sw.url()).host;
    await sw.evaluate(() => chrome.storage.local.set({ 'onboarding:dismissed': true }));

    const panel = await context.newPage();
    await panel.setViewportSize(VIEWPORT);
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await configureProvider(panel);
    await startSession(panel);

    // The demo page is the session's target tab (background.ts targets the active tab).
    const demo = await context.newPage();
    await demo.setViewportSize(VIEWPORT);
    await demo.goto(DEMO_URL);
    await demo.bringToFront();
    await demo.locator(CTA).waitFor({ state: 'visible' });

    await enableOnPageOverlay(panel);

    // SHOT 4 — picker first: click the composer's context-pin button, then hover the CTA so the
    // picker's hover box + selector label render (clicking would commit and end the pick).
    await panel.locator('.dz-composer__attach').click();
    await waitText(panel.locator('.dz-context-chip'), /Picking element/, 'picker armed');
    await demo.locator(CTA).hover();
    const pickerSel = demo.locator('#dz-designer-picker .dz-sel');
    await waitText(pickerSel, /\[data-testid="cta-start"\]/, 'picker hover label');
    await demo.locator('#dz-designer-picker .dz-hover').waitFor({ state: 'visible' });
    await shot(demo, 'shot-4-picker.png');

    // Commit the pin (plain click = single-select pin) — proves the pin flow lands end to end.
    await demo.locator(CTA).click();
    await waitText(
      panel.locator('.dz-context-chip__label'),
      /\[data-testid="cta-start"\] · data attr/,
      'context pin',
    );
    // The picker stays ACTIVE after a commit (picker.ts only stops on Escape/dismiss), so its
    // hover pill would linger over the CTA in shot 2 and conflate picker chrome with the
    // mutation highlight. Escape is the real user keybinding to end the pick; it also clears
    // the chip (reduceFocus resets on picker-state:inactive), so the turn runs unpinned.
    await demo.keyboard.press('Escape');
    await waitFor(
      async () => (await panel.locator('.dz-context-chip').count()) === 0,
      'picker closed',
    );

    // Send the instruction; the setStyle turn runs for real against the demo tab.
    await panel.getByPlaceholder('Tell the agent what to change…').fill(USER_MESSAGE);
    await panel.getByRole('button', { name: 'Send', exact: true }).click();

    // Request 2 starting proves setStyle already executed (the loop re-asks after each tool).
    await waitFor(async () => requests.length === 2, 'setStyle turn done');

    // SHOT 2 — the CTA is emerald and the overlay's mutation mark sits on it. The recordEdit
    // request is still parked on the gate, so nothing has hidden the mark yet.
    await waitFor(
      async () =>
        (await demo.locator(CTA).evaluate((el) => getComputedStyle(el).backgroundColor)) ===
        'rgb(5, 150, 105)',
      'CTA emerald',
    );
    await demo.locator('#dz-designer-overlay .dz-mark').waitFor({ state: 'visible' });
    await shot(demo, 'shot-2-live-highlight.png');

    // Let recordEdit + the summary land: the turn completes.
    releaseRecord();
    await waitFor(async () => requests.length === 3, 'assistant summary turn');
    await waitText(
      panel.locator('.dz-message--assistant').last(),
      /now pops in emerald/,
      'assistant reply',
    );
    await waitFor(
      async () =>
        (await panel.locator('.dz-tool-chip--done').count()) >= 1 &&
        (await panel.locator('.dz-tool-chip__name', { hasText: 'setStyle' }).count()) === 1,
      'tool chip done',
    );

    // SHOT 1 — the completed chat turn: user message, done tool chips, assistant reply.
    await shot(panel, 'shot-1-chat-turn.png');

    // Follow-up turn: a second real edit so the Diff review and the Ship foot have a fuller,
    // non-duplicate story (shots 3+5 differ from shot 1 by a whole exchange).
    await panel.getByPlaceholder('Tell the agent what to change…').fill(FOLLOW_UP_MESSAGE);
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await waitFor(async () => requests.length === 6, 'follow-up turn done');
    await waitText(
      panel.locator('.dz-message--assistant').last(),
      /soft emerald glow/,
      'follow-up reply',
    );

    // SHOT 3 — the Diff tab: two recorded edits with the before/after style tables + undo bar.
    await panel.getByRole('button', { name: 'Diff' }).click();
    await waitText(panel.locator('.dz-diff__count'), /2 edits/, 'diff count');
    await waitFor(async () => (await panel.locator('.dz-diff__item').count()) === 2, 'diff rows');
    await shot(panel, 'shot-3-diff-review.png');

    // SHOT 5 — back on Chat: the handoff foot (Ship / Download brief / Send to…) after the edits.
    await panel.getByRole('button', { name: 'Chat' }).click();
    const shipButton = panel.getByRole('button', { name: 'Ship' });
    await shipButton.waitFor({ state: 'visible' });
    await panel.getByRole('button', { name: 'Download brief' }).waitFor({ state: 'visible' });
    await shipButton.hover();
    await shot(panel, 'shot-5-ship.png');
  } finally {
    await context.close();
  }
}

await main();
