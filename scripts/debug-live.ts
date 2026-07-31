#!/usr/bin/env bun
// Live debug driver: load the BUILT extension in a real Chromium, configure the provider through
// the actual Settings UI with a real BYOK key, run a real turn against a real page, and print
// every console line from all three worlds (service worker / side panel / page) as it happens.
//
// Why this exists: the three-world split (CLAUDE.md "MV3 three worlds") means the interesting
// failures — a key that never reaches the SW, a content script that was never injected, a stream
// that dies on the first model call — are invisible to unit and integration tests, and the E2E
// suite deliberately stubs the network at the wire. This drives the real thing end to end.
//
// Config comes from `.env` (see `.env.example`); nothing is written back to the repo. Keep the
// model CHEAP — every run spends real credit.
//
//   bun run debug:live                          # provider setup + a real turn on DZ_DEBUG_URL
//   bun run debug:live -- --say "make it dark"  # a different instruction
//   bun run debug:live -- --no-turn             # setup + readiness only, spends nothing
//   bun run debug:live -- --headed              # watch it

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type BrowserContext, chromium, type Page, type Worker } from '@playwright/test';

const EXTENSION_DIR = path.resolve(process.cwd(), 'build/chrome-mv3');
const TURN_TIMEOUT_MS = 120_000;

// --- config ---------------------------------------------------------------

/** Minimal `.env` reader — a few `KEY=value` lines, `#` comments, no interpolation. Real env vars
 *  win, so a one-off `DZ_DEBUG_MODEL=... bun run debug:live` needs no file edit. */
function loadEnv(file = '.env'): void {
  const full = path.resolve(process.cwd(), file);
  if (!existsSync(full)) return;
  for (const line of readFileSync(full, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = (raw ?? '').trim().replace(/^["']|["']$/g, '');
  }
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

// --- logging --------------------------------------------------------------

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function step(text: string): void {
  console.info(`\n${CYAN}▸ ${text}${RESET}`);
}

const okLine = (text: string): void => ok(text);

function ok(text: string): void {
  console.info(`${GREEN}✓${RESET} ${text}`);
}

function bad(text: string): void {
  console.info(`${RED}✗ ${text}${RESET}`);
}

/** Mirror one world's console into ours, tagged. Errors are highlighted — a red line here is the
 *  whole point of the script. */
function pipeConsole(source: Page | Worker, tag: string): void {
  source.on('console', (msg) => {
    const type = msg.type();
    const color = type === 'error' ? RED : type === 'warning' ? YELLOW : DIM;
    console.info(`${color}[${tag}:${type}]${RESET} ${msg.text()}`);
  });
  if ('on' in source) {
    (source as Page).on?.('pageerror', (err) => {
      console.info(`${RED}[${tag}:pageerror]${RESET} ${err.message}`);
    });
  }
}

// --- turn trace -----------------------------------------------------------

/** One `SwToPanel` event, flattened to the fields a trace cares about. Shapes come from
 *  `src/shared/messages.ts`'s SwToPanel union — kept structural here so this script never has to
 *  import extension code (it runs outside the bundle, against the BUILT extension). */
interface StreamEvent {
  type: string;
  tool?: string;
  id?: string;
  selector?: string;
  ok?: boolean;
  error?: string;
  usage?: { steps: number; tokens: number };
  text?: string;
}
type TracedEvent = StreamEvent & { at: number };

const events: TracedEvent[] = [];
const callStartedAt = new Map<string, number>();

/** Live per-event narration. Tool calls print on request and are amended on their result, so the
 *  trace reads as the agent's actual trajectory with the latency of each step. */
function report(e: StreamEvent): void {
  if (e.type === 'tool-call') {
    if (e.id) callStartedAt.set(e.id, Date.now());
    const target = e.selector ? ` ${DIM}${e.selector}${RESET}` : '';
    console.info(`  ${CYAN}→${RESET} ${e.tool}${target}`);
  } else if (e.type === 'tool-result') {
    const started = e.id ? callStartedAt.get(e.id) : undefined;
    const ms = started ? `${Date.now() - started}ms` : '';
    if (e.ok === false) bad(`    ${e.tool} failed after ${ms}: ${e.error ?? 'unknown'}`);
    else console.info(`    ${DIM}${e.tool} ok ${ms}${RESET}`);
  } else if (e.type === 'error') {
    bad(`stream error: ${e.error ?? 'unknown'}`);
  }
}

/** Print one turn's performance shape and say whether it actually succeeded. Returns false on a
 *  failed turn so the process can exit non-zero — this script is meant to be usable as a check,
 *  not just as a log. */
function summarizeTurn(turn: TracedEvent[], elapsedMs: number): boolean {
  const calls = turn.filter((e) => e.type === 'tool-call');
  const results = turn.filter((e) => e.type === 'tool-result');
  const failures = results.filter((e) => e.ok === false);
  const errors = turn.filter((e) => e.type === 'error');
  const done = turn.find((e) => e.type === 'turn-done');
  const usage = done?.usage;
  const text = turn
    .filter((e) => e.type === 'token')
    .map((e) => e.text ?? '')
    .join('');

  step('turn summary');
  console.info(
    `${DIM}${(elapsedMs / 1000).toFixed(1)}s · ${calls.length} tool calls ` +
      `(${failures.length} failed) · ${usage ? `${usage.steps} steps, ${usage.tokens} tokens` : 'no usage reported'}${RESET}`,
  );
  // Which tools it reached for, most-used first — the cheapest read on whether the agent is
  // working the page or thrashing (10 × `query` and no `setStyle` is a different bug from a 401).
  const byTool = new Map<string, number>();
  for (const c of calls) byTool.set(c.tool ?? '?', (byTool.get(c.tool ?? '?') ?? 0) + 1);
  const histogram = [...byTool.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tool, n]) => `${tool}×${n}`)
    .join(' ');
  if (histogram) console.info(`${DIM}tools: ${histogram}${RESET}`);
  if (text.trim()) console.info(`${DIM}reply: ${text.trim().slice(0, 400)}${RESET}`);

  for (const e of errors) bad(e.error ?? 'unknown error');
  for (const f of failures) bad(`${f.tool}: ${f.error ?? 'failed'}`);

  if (errors.length > 0) return false;
  if (!done) {
    bad(`no turn-done within ${TURN_TIMEOUT_MS / 1000}s`);
    return false;
  }
  ok('turn completed');
  return true;
}

// --- screenshots ------------------------------------------------------------

let shotDir: string | null = null;
let shotIndex = 0;

/** Save a numbered PNG of `target`, if `--shots` asked for them. Numbered so the directory reads
 *  as the flow in order. Failures are swallowed — a missed screenshot must never fail a debug run. */
async function shot(target: Page, name: string): Promise<void> {
  if (!shotDir) return;
  shotIndex += 1;
  const file = path.join(shotDir, `${String(shotIndex).padStart(2, '0')}-${name}.png`);
  try {
    await target.screenshot({ path: file });
    console.info(`${DIM}  shot: ${file}${RESET}`);
  } catch (err) {
    console.info(`${DIM}  shot ${name} failed: ${String(err)}${RESET}`);
  }
}

// --- driver ---------------------------------------------------------------

async function serviceWorker(context: BrowserContext): Promise<Worker> {
  const [existing] = context.serviceWorkers();
  return existing ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
}

/** Configure the provider through the REAL Settings UI, not by seeding storage: the point is to
 *  exercise the path a user takes (panel → `save-provider` RPC → host grant → key-store encrypt →
 *  `/models` auth probe), which is exactly where a key can silently fail to land. */
async function configureProvider(panel: Page, cfg: Config): Promise<boolean> {
  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.locator('#dz-key').fill(cfg.apiKey);
  await panel.getByRole('button', { name: 'Refresh' }).click();
  // The combobox is free-text, so a model absent from /models still saves — which is also how a
  // brand-new id (`minimax/hailuo-3`) is configured.
  const model = panel.locator('#dz-model');
  await model.fill(cfg.model);
  await model.press('Enter');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  // Save is async (host grant → persist → auth probe), so the status starts at "Validating…" —
  // waiting for the element alone would report that transient as the verdict.
  const status = panel.locator('.dz-settings__status');
  await status.filter({ hasNotText: 'Validating' }).waitFor({ timeout: 45_000 });
  const text = (await status.textContent())?.trim() ?? '';
  const good = await status.evaluate((el) => el.classList.contains('is-ok'));
  (good ? ok : bad)(`settings status: ${text}`);
  return good;
}

/** Ask for the readiness truth table — the same RPC the header pill renders. Sent from the PANEL,
 *  not the worker: `chrome.runtime.sendMessage` called inside the service worker never reaches its
 *  own `onMessage` listener. */
async function readReadiness(panel: Page): Promise<unknown> {
  return panel.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: crossing into the page context, untyped by design
    const r: any = await chrome.runtime.sendMessage({ type: 'readiness' });
    return r?.state;
  });
}

interface Config {
  apiKey: string;
  baseURL: string;
  model: string;
  url: string;
  say: string;
  headed: boolean;
  runTurn: boolean;
  overlay: boolean;
  repeat: number;
  probe: boolean;
  /** Directory for step-by-step PNGs of the panel and the page, or null to skip. */
  shots: string | null;
}

async function main(): Promise<void> {
  loadEnv();

  const cfg: Config = {
    apiKey: process.env.DZ_DEBUG_API_KEY ?? '',
    baseURL: option('base-url', process.env.DZ_DEBUG_BASE_URL ?? 'https://openrouter.ai/api/v1'),
    model: option('model', process.env.DZ_DEBUG_MODEL ?? 'qwen/qwen3.7-flash'),
    url: option('url', process.env.DZ_DEBUG_URL ?? 'https://example.com'),
    say: option('say', 'Make the main heading bright orange and twice as large.'),
    headed: flag('headed') || process.env.DZ_DEBUG_HEADED === '1',
    runTurn: !flag('no-turn'),
    overlay: flag('overlay'),
    probe: flag('probe'),
    // Repeat the same instruction N times in one session — the cheapest read on whether the
    // agent is consistent, and on how a growing thread affects step count.
    repeat: Math.max(1, Number(option('repeat', '1')) || 1),
    // Screenshots are the only way to answer "does it actually LOOK right" — the console trace
    // proves the turn ran, not that the panel rendered the state it reports.
    shots: flag('shots') ? option('shots', '.debug-shots') : null,
  };

  if (!cfg.apiKey) {
    bad('No DZ_DEBUG_API_KEY — copy .env.example to .env and paste a provider key.');
    process.exit(1);
  }
  if (!existsSync(EXTENSION_DIR)) {
    bad(`No build at ${EXTENSION_DIR} — run \`bun run build\` first.`);
    process.exit(1);
  }

  console.info(
    `${DIM}provider ${cfg.baseURL} · model ${cfg.model} · page ${cfg.url}` +
      `${cfg.runTurn ? '' : ' · setup only'}${RESET}`,
  );

  if (cfg.shots) {
    shotDir = path.resolve(process.cwd(), cfg.shots);
    mkdirSync(shotDir, { recursive: true });
    console.info(`${DIM}screenshots -> ${shotDir}${RESET}`);
  }

  step('launching Chromium with the unpacked extension');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !cfg.headed,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  });

  let failed = false;
  try {
    const sw = await serviceWorker(context);
    pipeConsole(sw, 'sw');
    const extensionId = new URL(sw.url()).host;
    ok(`extension ${extensionId}`);

    step('opening the side panel');
    const panel = await context.newPage();
    pipeConsole(panel, 'panel');
    // Chrome pins the side panel to ~360px; match it so screenshots show the real layout rather
    // than a full-width tab the user will never see.
    await panel.setViewportSize({ width: 360, height: 720 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    // Skip the first-run guide — it is a modal over the tab shell, and this driver is not here to
    // test onboarding.
    await sw.evaluate(() => chrome.storage.local.set({ 'onboarding:dismissed': true }));
    await panel.reload();
    await shot(panel, 'panel-fresh-install');

    step('configuring the provider through the Settings UI');
    if (!(await configureProvider(panel, cfg))) failed = true;
    await shot(panel, 'settings-after-save');

    // The model list OPEN — the closed field tells you nothing about how the popover reads.
    await panel.locator('#dz-model').click();
    await shot(panel, 'model-list-open');
    await panel.keyboard.press('Escape');

    step('readiness truth table (what the header pill reports)');
    console.info(JSON.stringify(await readReadiness(panel), null, 2));
    // The dropdown open, so the shot shows the per-row verdicts the JSON above describes.
    await panel.locator('.dz-readiness__pill').click();
    await shot(panel, 'readiness-dropdown');
    await panel.locator('.dz-readiness__pill').click();

    step(`opening the target page: ${cfg.url}`);
    const page = await context.newPage();
    pipeConsole(page, 'page');
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront(); // the SW targets the active tab of the last-focused window
    await shot(page, 'page-before');
    // Resolve the page tab BY URL, not by "active": the side panel stand-in is itself a tab here,
    // and addressing it would produce a "Receiving end does not exist" that says nothing about the
    // page (an extension page has no content script by design).
    const pageTabId = await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const match = tabs.find((t) => t.url === url) ?? tabs.find((t) => t.url?.startsWith('http'));
      return match?.id ?? -1;
    }, cfg.url);
    console.info(`${DIM}page tab: ${pageTabId}${RESET}`);
    console.info(
      `${DIM}tabs: ${JSON.stringify(
        await sw.evaluate(async () =>
          (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url?.slice(0, 60) })),
        ),
      )}${RESET}`,
    );

    // Quick pick (Alt+click) QA — no model call, so it runs even under --no-turn. Holding Alt
    // must outline the element under the pointer; Alt+click must pin it as chat context.
    // --- tool probe -------------------------------------------------------
    // Run the read tools DIRECTLY against the page and print what they actually return. The turn
    // trace only shows ok/failed; it cannot tell "the tool returned the page" from "the tool
    // returned nothing and the model made the answer up", which is the difference between a
    // working describe and a confabulated one.
    if (cfg.probe) {
      step('probing the read tools directly (no model call)');
      const probes: { label: string; message: Record<string, unknown> }[] = [
        { label: 'describe(content)', message: { type: 'describe', mode: 'content' } },
        { label: 'describe(layout)', message: { type: 'describe', mode: 'layout' } },
        { label: 'extractIdentity', message: { type: 'extractIdentity' } },
        { label: 'query(a)', message: { type: 'query', selector: 'a' } },
      ];
      for (const probe of probes) {
        // Retry: content scripts run at `document_idle`, i.e. after `load`. A page heavier than
        // example.com is still injecting when the first probe fires, and the resulting "Receiving
        // end does not exist" reads exactly like a broken tool transport when it is only a race.
        // (test/e2e/dom-tools.spec.ts's `sendToContent` retries for the same reason.)
        let result: unknown = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          result = await sw.evaluate(
            async ({ tabId, message }) =>
              chrome.tabs
                .sendMessage(tabId, message, { frameId: 0 })
                .catch((e) => ({ threw: String(e) })),
            { tabId: pageTabId, message: probe.message },
          );
          if (!(result as { threw?: string })?.threw) break;
          await panel.waitForTimeout(250);
        }
        const json = JSON.stringify(result);
        const ok = (result as { ok?: boolean })?.ok;
        (ok ? okLine : bad)(`${probe.label}: ${json.length} chars — ${json.slice(0, 400)}`);
      }
    }

    // The context chip lives in the composer, which only mounts once a session is open — so the
    // session has to be started before this is a meaningful check. `session-start` costs nothing
    // (no model call), so it runs even under --no-turn.
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'session-start' }));
    await panel.getByRole('button', { name: 'Chat' }).click();

    step('quick pick: hold Alt, hover, click');
    const target = await page
      .locator('h1, h2, a, button, p')
      .first()
      .elementHandle()
      .catch(() => null);
    if (!target) {
      bad('no element to pick on this page');
    } else {
      await page.keyboard.down('Alt');
      await target.hover();
      await shot(page, 'quickpick-hover');
      const outlined = await page.evaluate(() => {
        const host = document.getElementById('dz-designer-picker');
        const box = host?.shadowRoot?.querySelector('.dz-hover');
        const pill = host?.shadowRoot?.querySelector('.dz-pill');
        return {
          mounted: !!host,
          outlined: !!box && !box.classList.contains('dz-hidden'),
          label: pill?.textContent?.trim() ?? null,
        };
      });
      (outlined.outlined ? ok : bad)(
        `hold-Alt outline: mounted=${outlined.mounted} visible=${outlined.outlined} pill=${JSON.stringify(outlined.label)}`,
      );
      await target.click({ modifiers: ['Alt'] });
      await page.keyboard.up('Alt');
      await shot(page, 'quickpick-flash');
      // The panel is where the pin has to LAND — the chip is the agent's context.
      await panel.bringToFront();
      const chip = await panel
        .locator('.dz-context-chip')
        .textContent({ timeout: 4000 })
        .catch(() => null);
      (chip ? ok : bad)(`context chip: ${chip ?? 'NOT SHOWN'}`);
      await shot(panel, 'quickpick-chip');
      await page.bringToFront();
    }

    if (!cfg.runTurn) {
      ok('setup only (--no-turn) — nothing was spent');
      return;
    }

    if (cfg.overlay) {
      step('enabling the on-page overlay');
      const res = await panel.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'set-overlay-enabled', enabled: true }),
      );
      const reached = (res as { reachedPage?: boolean })?.reachedPage;
      (reached ? ok : bad)(
        reached
          ? 'overlay pushed to the page'
          : 'overlay saved but the page has NO content script (needs a reload)',
      );
    }

    step('subscribing to the panel stream');
    // Read the panel's own stream events rather than scraping the DOM: this is the exact channel
    // the UI renders from, so an error here is the error the user would see, and the tool-call /
    // tool-result pair is the agent's actual trajectory.
    await panel.exposeFunction('__dzDebugEvent', (e: StreamEvent) => {
      events.push({ ...e, at: Date.now() });
      report(e);
    });
    await panel.evaluate(() => {
      // Must be the SW's expected port name (`src/shared/port.ts` PORT_NAME) — background.ts
      // ignores a connection under any other name, which silently yields zero events.
      const port = chrome.runtime.connect({ name: 'dz-sw-panel' });
      port.onMessage.addListener((msg: Record<string, unknown>) => {
        (window as unknown as { __dzDebugEvent: (e: unknown) => void }).__dzDebugEvent({
          type: msg.type,
          tool: msg.tool,
          id: msg.id,
          selector: msg.selector,
          ok: msg.ok,
          error: msg.error ?? msg.message,
          usage: msg.usage,
          text: msg.text,
        });
      });
    });
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'session-start' }));

    for (let i = 1; i <= cfg.repeat; i += 1) {
      const prompt = cfg.say;
      step(cfg.repeat > 1 ? `turn ${i}/${cfg.repeat}: "${prompt}"` : `running a turn: "${prompt}"`);
      const startedAt = Date.now();
      const before = events.length;
      await panel.evaluate(
        (text) => chrome.runtime.sendMessage({ type: 'user-message', text }),
        prompt,
      );

      const deadline = Date.now() + TURN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const since = events.slice(before);
        if (since.some((e) => e.type === 'turn-done' || e.type === 'error')) break;
        await panel.waitForTimeout(250);
      }
      if (!summarizeTurn(events.slice(before), Date.now() - startedAt)) failed = true;
      await shot(panel, `panel-turn-${i}`);
      await shot(page, `page-turn-${i}`);
    }
  } finally {
    await context.close();
  }

  process.exit(failed ? 1 : 0);
}

await main();
