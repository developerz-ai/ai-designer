#!/usr/bin/env bun
// Chrome Web Store asset generator: five 1280×800 screenshots + the 440×280 promo tile,
// rendered from the BUILT extension driving a real (stubbed-provider) session in headless
// Chromium — the same harness family as test/e2e/fixtures.ts and scripts/debug-live.ts.
//
// Everything model-shaped is canned at the wire (mirrors test/e2e/chat-streaming.spec.ts's
// stubProvider): the picker, the cross-world tool dispatch, the live DOM edits on the demo
// page, and the Solid render are all real. No key is used and nothing leaves the machine.
//
//   bun run store:shots          # writes docs/store/assets/*.png (build first: bun run build)
//
// The composition pass re-frames raw captures into store-ready 1280×800 frames (browser-chrome
// mock around the demo page, panel beside it, headline for panel-only scenes) so the store
// listing reads as a product, not a bare window dump.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type BrowserContext, chromium, type Page } from '@playwright/test';

const EXTENSION_DIR = path.resolve(process.cwd(), 'build/chrome-mv3');
const OUT_DIR = path.resolve(process.cwd(), 'docs/store/assets');
const BASE_URL = 'https://openrouter.ai/api/v1';
const DEMO_URL = 'https://demo.northwind.dev/';

// --- canned provider (SSE), copied shape-for-shape from chat-streaming.spec.ts ------------------

function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const payload = {
    id: 'store-chunk',
    created: 0,
    model: 'anthropic/claude-sonnet-5',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason
      ? { usage: { prompt_tokens: 1800, completion_tokens: 240, total_tokens: 2040 } }
      : {}),
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textStream(text: string): string {
  return (
    sseChunk({ role: 'assistant' }) +
    text
      .split(/(?<= )/)
      .map((word) => sseChunk({ content: word }))
      .join('') +
    sseChunk({}, 'stop') +
    'data: [DONE]\n\n'
  );
}

function toolCallStream(id: string, name: string, args: unknown): string {
  return (
    sseChunk({ role: 'assistant' }) +
    sseChunk({
      tool_calls: [
        { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ],
    }) +
    sseChunk({}, 'tool_calls') +
    'data: [DONE]\n\n'
  );
}

/** The model-facing surface is grouped into resources discriminated on `op`
 *  (src/agent/tools/resources.ts) — same mapping the e2e fixtures read off `RESOURCE_OF`,
 *  hardcoded here for the two verbs this script drives. */
const edit = (op: string, args: Record<string, unknown>) => ({
  name: 'edit',
  arguments: { op, ...args },
});

// --- the demo page ------------------------------------------------------------------------------
// A deliberately "almost there" SaaS landing: gray CTA, flat stat cards. The canned turns are the
// agent branding it — every visible change in the hero shot is a REAL DOM edit the extension made.

const DEMO_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Northwind Analytics</title>
<style>
  * { margin:0; box-sizing:border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color:#1e293b; background:#fff; }
  nav { display:flex; align-items:center; gap:28px; padding:18px 48px; border-bottom:1px solid #e2e8f0; }
  .brand { font-weight:800; font-size:18px; letter-spacing:-.02em; }
  .brand b { color:#6366f1; }
  nav a { color:#64748b; text-decoration:none; font-size:14px; }
  nav .spacer { flex:1; }
  .nav-cta { border:1px solid #cbd5e1; border-radius:8px; padding:8px 16px; font-size:14px; color:#334155; }
  .hero { padding:72px 48px 56px; max-width:960px; }
  .kicker { display:inline-block; font-size:12px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:#64748b; background:#f1f5f9; border-radius:99px; padding:6px 12px; margin-bottom:20px; }
  h1 { font-size:52px; line-height:1.08; letter-spacing:-.03em; font-weight:800; max-width:640px; }
  .sub { margin-top:18px; font-size:18px; color:#64748b; max-width:520px; line-height:1.55; }
  .cta-row { margin-top:32px; display:flex; gap:14px; align-items:center; }
  #cta { border:0; border-radius:8px; padding:14px 26px; font-size:16px; font-weight:600; cursor:pointer; background:#e2e8f0; color:#334155; }
  .ghost { font-size:15px; color:#475569; text-decoration:none; }
  .stats { display:flex; gap:16px; padding:8px 48px 64px; }
  .stat { flex:1; border:1px solid #e2e8f0; border-radius:12px; padding:22px; }
  .stat b { font-size:28px; letter-spacing:-.02em; }
  .stat span { display:block; margin-top:6px; color:#64748b; font-size:14px; }
</style></head><body>
  <nav><span class="brand">north<b>wind</b></span><a href="#">Product</a><a href="#">Pricing</a><a href="#">Docs</a><span class="spacer"></span><a class="nav-cta" href="#">Sign in</a></nav>
  <section class="hero">
    <span class="kicker">Realtime revenue analytics</span>
    <h1 id="headline">Know your numbers before your board does.</h1>
    <p class="sub">Northwind streams every metric that matters into one dashboard — pipeline, churn, and burn, updated the second they change.</p>
    <div class="cta-row"><button id="cta">Start free trial</button><a class="ghost" href="#">Book a demo →</a></div>
  </section>
  <section class="stats">
    <div class="stat"><b>2,400+</b><span>Teams on Northwind</span></div>
    <div class="stat"><b>99.98%</b><span>Uptime, last 12 months</span></div>
    <div class="stat"><b>4 min</b><span>Median setup time</span></div>
  </section>
</body></html>`;

// --- the canned session -------------------------------------------------------------------------

const INSTRUCTION =
  'Make the hero feel premium — brand the CTA and give the headline more presence';

const TURNS = [
  toolCallStream(
    'c1',
    'edit',
    edit('setStyle', {
      intent: 'Brand the primary CTA with the indigo gradient',
      selector: '#cta',
      props: {
        background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
        color: '#ffffff',
        'box-shadow': '0 10px 28px rgba(99,102,241,.32)',
        'border-radius': '10px',
      },
    }).arguments,
  ),
  toolCallStream(
    'c2',
    'edit',
    edit('setStyle', {
      intent: 'Give the headline more presence',
      selector: '#headline',
      props: { 'font-size': '58px', color: '#0f172a', 'letter-spacing': '-0.035em' },
    }).arguments,
  ),
  // No explicit recordEdit turns: setStyle mutations auto-record into the changeset (the
  // "2 edits" chip in the shot is real), and a canned recordEdit drifting from the live schema
  // renders as a red invalidTool chip — exactly what a store screenshot must not show.
  textStream(
    'Done — the CTA now carries the indigo brand gradient with a soft elevation shadow, ' +
      'and the headline steps up to 58px in the darkest ink for real presence. ' +
      'Both edits are recorded in the changeset — review them in Diff, undo either one, ' +
      'or Ship when it looks right.',
  ),
];

// --- harness ------------------------------------------------------------------------------------

async function seedOnboarding(context: BrowserContext, dismissed: boolean): Promise<void> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  await sw.evaluate(async (d) => {
    await chrome.storage.local.set({ 'onboarding:dismissed': d });
  }, dismissed);
}

async function stubNetwork(context: BrowserContext): Promise<void> {
  await context.route(`${BASE_URL}/models`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
          { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' },
        ],
      }),
    }),
  );
  await context.route(`${BASE_URL.replace(/\/+$/, '')}/key`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { label: 'store-shots', usage: 0 } }),
    }),
  );
  let turn = 0;
  await context.route(`${BASE_URL}/chat/completions`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: TURNS[turn++] ?? textStream('(extra turn)'),
    }),
  );
  await context.route(`${DEMO_URL}**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: DEMO_PAGE }),
  );
}

async function openRoom(panel: Page, name: string): Promise<void> {
  await panel.getByRole('button', { name: 'Designer' }).click();
  await panel.locator('#dz-nav-menu').getByRole('button', { name }).click();
}

async function configureProvider(panel: Page): Promise<void> {
  await openRoom(panel, 'Settings');
  // ASCII only — the key rides an Authorization header, and a typographic ellipsis in it
  // fails the SW's fetch outright ("String contains non ISO-8859-1 code point").
  await panel.locator('#dz-key').fill('sk-or-v1-your-own-key-here');
  await panel.getByRole('button', { name: 'Refresh' }).click();
  // #dz-model is a text combobox (ModelCombobox), disabled while the catalogue loads and NOT
  // auto-filled when more than one model comes back — type the pick, then Save (whose click
  // blurs the input, which is what commits a typed value).
  await panel.waitForFunction(
    () => (document.querySelector('#dz-model') as HTMLInputElement | null)?.disabled === false,
    undefined,
    { timeout: 15_000 },
  );
  const model = panel.locator('#dz-model');
  await model.fill('anthropic/claude-sonnet-5');
  // Enter takes the highlighted row AND closes the list — the open listbox otherwise covers
  // the Save button and Playwright (correctly) refuses the click.
  await model.press('Enter');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await panel.getByText('Provider saved and reachable.').waitFor({ timeout: 15_000 });
}

// --- composition --------------------------------------------------------------------------------

const b64 = (buf: Buffer): string => `data:image/png;base64,${buf.toString('base64')}`;

const FRAME_CSS = `
  * { margin:0; box-sizing:border-box; }
  body { width:1280px; height:800px; overflow:hidden; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         background: radial-gradient(1200px 700px at 18% -10%, #23263a 0%, #101118 52%, #0b0c11 100%);
         display:flex; align-items:center; justify-content:center; gap:18px; }
  .window { border-radius:12px; overflow:hidden; box-shadow: 0 24px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.07); background:#0f1014; }
  .bar { height:34px; display:flex; align-items:center; gap:6px; padding:0 12px; background:#191b22; }
  .dot { width:10px; height:10px; border-radius:50%; }
  .url { margin-left:10px; flex:1; max-width:420px; height:20px; border-radius:6px; background:#101218;
         color:#8b90a0; font-size:11px; display:flex; align-items:center; padding:0 10px; }
  .body { display:block; }
  .body img { display:block; }
  .headline { color:#f3f4f8; max-width:420px; }
  .headline h1 { font-size:42px; line-height:1.1; letter-spacing:-.02em; font-weight:800; }
  .headline p { margin-top:14px; font-size:17px; line-height:1.55; color:#a3a8b8; }
  .headline .logo { display:flex; align-items:center; gap:10px; margin-bottom:26px; color:#c9cbe0; font-weight:700; font-size:15px; }
  .headline .logo img { width:28px; height:28px; border-radius:7px; }
`;

const dots = `<span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>`;

function windowFrame(img: string, width: number, url?: string): string {
  return `<div class="window" style="width:${width}px">
    <div class="bar">${dots}${url ? `<span class="url">${url}</span>` : ''}</div>
    <div class="body"><img src="${img}" style="width:${width}px" /></div>
  </div>`;
}

async function renderComposition(
  context: BrowserContext,
  html: string,
  out: string,
): Promise<void> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(
    `<!doctype html><html><head><style>${FRAME_CSS}</style></head><body>${html}</body></html>`,
  );
  await page.waitForTimeout(250); // let images decode
  await page.screenshot({ path: out });
  await page.close();
  console.log(`  wrote ${path.relative(process.cwd(), out)}`);
}

// --- scenes -------------------------------------------------------------------------------------

let panelForDiagnostics: Page | undefined;

async function dumpFailureState(err: unknown): Promise<void> {
  console.error(String(err));
  const panel = panelForDiagnostics;
  if (!panel || panel.isClosed()) return;
  try {
    await panel.screenshot({ path: path.join(OUT_DIR, 'failure-panel.png') });
    const status = await panel
      .locator('.dz-settings__status')
      .innerText({ timeout: 1_000 })
      .catch(() => '(no status element)');
    const body = await panel
      .locator('body')
      .innerText({ timeout: 1_000 })
      .catch(() => '');
    console.error(`settings status: ${status}`);
    console.error(`panel text:\n${body.slice(0, 2_000)}`);
  } catch {
    // diagnostics must never mask the real failure
  }
}

async function main(): Promise<void> {
  if (!existsSync(EXTENSION_DIR)) {
    throw new Error(`Built extension not found at ${EXTENSION_DIR} — run \`bun run build\` first.`);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  });
  try {
    await stubNetwork(context);
    await seedOnboarding(context, true);

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(sw.url()).host;

    const panel = await context.newPage();
    await panel.setViewportSize({ width: 392, height: 704 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    // Any failure below dumps the panel's state — a blind TimeoutError from CI costs a full
    // build round-trip to diagnose; a screenshot + the status line usually names the cause.
    panelForDiagnostics = panel;

    console.log('configuring provider…');
    await configureProvider(panel);
    const settingsShot = await panel.screenshot();

    // Start the session, then run the canned turn against the demo page.
    const toggle = panel.locator('.dz-readiness__toggle');
    await toggle.click();
    await panel
      .locator('.dz-readiness__pill')
      .getByText(/Running/)
      .waitFor({ timeout: 15_000 });
    await openRoom(panel, 'Chat');

    const demo = await context.newPage();
    await demo.setViewportSize({ width: 832, height: 704 });
    await demo.goto(DEMO_URL);
    await demo.bringToFront();

    console.log('pinning the CTA…');
    await panel.locator('.dz-composer__attach--element').click();
    await panel
      .locator('.dz-context-chip')
      .getByText(/Picking element/)
      .waitFor({ timeout: 10_000 });
    await demo.locator('#cta').click();
    await panel.locator('.dz-context-chip__label').getByText('#cta').waitFor({ timeout: 10_000 });
    // The picker ACCUMULATES picks and stays armed — Escape is the documented finish. Without
    // it, every later mouse position paints a hover badge into the page captures.
    await demo.keyboard.press('Escape');

    console.log('running the canned turn…');
    await panel.getByPlaceholder('Tell the agent what to change…').fill(INSTRUCTION);
    await panel.getByRole('button', { name: 'Send' }).click();
    // .first(): the final text renders in the bubble AND the thread's aria-live announcer.
    await panel
      .getByText('recorded in the changeset', { exact: false })
      .first()
      .waitFor({ timeout: 45_000 });
    await panel.waitForTimeout(800); // stream settle + usage row

    const chatShot = await panel.screenshot();

    // Diff BEFORE unpinning — with the pin removed first, the Diff room rendered empty
    // (runs 8–9); with it still present (run 7) the per-edit before/after diffs show.
    console.log('capturing Diff…');
    await openRoom(panel, 'Diff');
    await panel.waitForTimeout(700);
    const diffText = await panel
      .locator('body')
      .innerText()
      .catch(() => '');
    console.log(`  diff room text: ${diffText.replace(/\n/g, ' | ').slice(0, 200)}`);
    const diffShot = await panel.screenshot();
    await openRoom(panel, 'Chat');

    // Unpin the element before shooting the page — the pin keeps the picker badge + outline
    // painted over the freshly-branded CTA. Mouse to plain whitespace so no hover survives.
    await panel.getByRole('button', { name: 'Remove this element' }).click();
    await demo.mouse.move(200, 650);
    await demo.waitForTimeout(500);
    const demoShot = await demo.screenshot();

    console.log('capturing History…');
    // End the session first — History lists archived conversations, and mid-session the room
    // rendered empty (run 7). The header toggle reads Stop while running.
    await panel.locator('.dz-readiness__toggle').click();
    await panel.waitForTimeout(1_000);
    await openRoom(panel, 'History');
    await panel.waitForTimeout(1_500);
    const historyText = await panel
      .locator('body')
      .innerText()
      .catch(() => '');
    console.log(`  history room text: ${historyText.replace(/\n/g, ' | ').slice(0, 300)}`);
    const historyShot = await panel.screenshot();

    console.log('capturing onboarding…');
    await seedOnboarding(context, false);
    const fresh = await context.newPage();
    await fresh.setViewportSize({ width: 392, height: 704 });
    await fresh.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await fresh.waitForTimeout(900);
    const onboardingShot = await fresh.screenshot();
    await fresh.close();

    // --- compose the five store frames ---
    console.log('composing store frames…');
    const logo = b64(
      Buffer.from(readFileSync(path.resolve(process.cwd(), 'src/public/icon/icon-128.png'))),
    );

    const heroHtml =
      windowFrame(b64(demoShot), 832, 'demo.northwind.dev') + windowFrame(b64(chatShot), 392);
    await renderComposition(context, heroHtml, path.join(OUT_DIR, 'shot-1-live-edit.png'));

    const diffHtml =
      windowFrame(b64(demoShot), 832, 'demo.northwind.dev') + windowFrame(b64(diffShot), 392);
    await renderComposition(context, diffHtml, path.join(OUT_DIR, 'shot-2-diff.png'));

    const headline = (h: string, p: string) =>
      `<div class="headline"><div class="logo"><img src="${logo}" />Developerz.ai Designer</div><h1>${h}</h1><p>${p}</p></div>`;

    await renderComposition(
      context,
      headline(
        'Bring your own key.',
        'Connect any OpenAI-compatible provider. Your key is encrypted, stays in your browser, and talks only to the provider you chose.',
      ) + windowFrame(b64(settingsShot), 392),
      path.join(OUT_DIR, 'shot-3-byok.png'),
    );
    await renderComposition(
      context,
      headline(
        'Every session, kept.',
        'Your last ten conversations and their handoff reports, stored locally — replay, re-download, or ship them later.',
      ) + windowFrame(b64(historyShot), 392),
      path.join(OUT_DIR, 'shot-4-history.png'),
    );
    await renderComposition(
      context,
      headline(
        'Meet your design agent.',
        'Three steps to your first live edit: connect a model, open a page, say what should change.',
      ) + windowFrame(b64(onboardingShot), 392),
      path.join(OUT_DIR, 'shot-5-onboarding.png'),
    );

    // --- promo tile 440×280 ---
    const tile = await context.newPage();
    await tile.setViewportSize({ width: 440, height: 280 });
    await tile.setContent(`<!doctype html><html><head><style>
      * { margin:0; box-sizing:border-box; }
      body { width:440px; height:280px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;
             font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
             background: radial-gradient(420px 300px at 30% -20%, #23263a 0%, #101118 55%, #0b0c11 100%); }
      img { width:64px; height:64px; border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,.5); }
      h1 { color:#f3f4f8; font-size:24px; letter-spacing:-.02em; }
      p { color:#a3a8b8; font-size:13px; }
    </style></head><body><img src="${logo}" /><h1>Developerz.ai Designer</h1><p>The AI design agent for your browser</p></body></html>`);
    await tile.waitForTimeout(200);
    await tile.screenshot({ path: path.join(OUT_DIR, 'promo-440x280.png') });
    await tile.close();
    console.log(`  wrote ${path.relative(process.cwd(), path.join(OUT_DIR, 'promo-440x280.png'))}`);

    console.log('done.');
  } catch (err) {
    await dumpFailureState(err); // before close() — diagnostics need the live panel
    throw err;
  } finally {
    await context.close();
  }
}

try {
  await main();
} catch {
  process.exit(1); // already dumped inside main, where the panel was still alive
}
