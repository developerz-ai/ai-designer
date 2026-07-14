import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// E2E: the Ship / handoff slice (07 — `docs/idea/handoff.md`) driven against a loaded, real
// Chromium, mirroring copy-debug.spec.ts's approach: ShipBar/TaskTimeline aren't mounted in the
// panel shell yet (App.tsx — integrating them "at thread foot" is PR15/ChatPanel-rebuild work), so
// these send the same `download-report` / `ship` / `send-report` RPCs those components will
// eventually send, straight to the already-real, already-wired SW handler (background.ts
// `runHandoffRoute`) — the exact mechanism a click will drive once the UI lands. The turn that
// produces the changeset uses the same `user-message` RPC copy-debug.spec.ts already establishes for
// a still-stubbed composer. Everything downstream of the RPC is real: the report is authored by a
// genuine (network-stubbed) model call, the page's design identity is read by the real content-script
// extractor against a real fixture page, and the Ship route drives a real `@ai-sdk/mcp` client against
// a stubbed MCP server (mirrors mcp.spec.ts) — only the LLM and MCP wire replies are canned.

const BASE_URL = 'https://openrouter.ai/api/v1';
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture-07/';

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

// Every `/chat/completions` POST is one of two shapes: the streaming tool-loop turn (`stream:true`,
// served in order from `turns[]`), or the report pass's non-streaming `generateObject` call
// (`src/agent/report.ts` via `background.ts`'s `reportGenerate`), served a single canned draft as a
// plain (non-SSE) chat-completion JSON body — exactly what `@ai-sdk/openai-compatible`'s `doGenerate`
// expects back.
function stubProvider(
  context: BrowserContext,
  turns: string[],
  reportDraft: Record<string, unknown>,
): { streamRequests: ChatRequestBody[]; reportRequests: ChatRequestBody[] } {
  const streamRequests: ChatRequestBody[] = [];
  const reportRequests: ChatRequestBody[] = [];
  void context.route(`${BASE_URL}/chat/completions`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as ChatRequestBody;
    if (body.stream) {
      const index = streamRequests.length;
      streamRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: turns[index] ?? textStream('(unexpected extra turn)'),
      });
      return;
    }
    reportRequests.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-report',
        object: 'chat.completion',
        created: 0,
        model: 'test/vision',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(reportDraft) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      }),
    });
  });
  return { streamRequests, reportRequests };
}

async function configureProvider(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-key').fill('sk-or-test-07');
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

// The one recorded edit every test in this file drives: a CTA recolor with a before/after
// screenshot, so the brief's "## Screenshots" section (and its embedded image link) has something
// real to show.
const RECORD_EDIT_ARGS = {
  intent: 'Recolor the CTA to the brand accent',
  selector: { value: '#cta', strategy: 'id' },
  changes: [{ prop: 'background-color', before: '#e5e7eb', after: '#22c55e' }],
  frameworkHints: [],
  screenshots: {
    before: 'data:image/png;base64,QkVGT1JF',
    after: 'data:image/png;base64,QUZURVI=',
  },
};

const OWN_PAGE =
  '<!doctype html><html><body style="background-color:#0f172a;color:#f8fafc;font-family:Georgia">' +
  '<h1 style="color:#f8fafc">My Hero</h1>' +
  '<button id="cta" style="background-color:#22c55e;color:#0f172a">Buy now</button>' +
  '</body></html>';

const REPORT_DRAFT = {
  summary: 'Recolored the CTA to the brand accent and tightened the hero copy.',
  findings: ['CTA now uses the brand accent green'],
  problems: ['Nav overflows the viewport at 375px', 'CTA contrast is borderline on white'],
  pros: ['Consistent use of the accent color'],
  cons: ['Type scale is inconsistent across sections'],
  recommendations: ['Adopt an 8px spacing grid'],
};

test.describe('handoff: download brief', () => {
  test('turn records an edit; download-report brings back a brief with tokens, problems, pros, and an image link', async ({
    context,
    openExtensionPage,
  }) => {
    await stubModels(context);
    await stubFixtures(context, { own: OWN_PAGE });
    const { streamRequests } = stubProvider(
      context,
      [
        toolCallStream('call-record', 'recordEdit', RECORD_EDIT_ARGS),
        textStream('Recolored your CTA to the brand accent green.'),
      ],
      REPORT_DRAFT,
    );

    const panel = await openExtensionPage('sidepanel.html');
    await configureProvider(panel);

    const ownPage = await context.newPage();
    await ownPage.goto(`${FIXTURE_PREFIX}own`);
    await ownPage.bringToFront();

    await sendUserMessage(panel, 'Recolor the CTA to the brand accent and record it', 'copy');
    await expect.poll(() => streamRequests.length, { timeout: 20_000 }).toBe(2);

    const result = (await panel.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'download-report' }),
    )) as { ok: boolean; routed?: string; markdown?: string; filename?: string };

    expect(result.ok).toBe(true);
    expect(result.routed).toBe('report');
    expect(result.filename).toMatch(/\.md$/);
    const md = result.markdown ?? '';

    // The model's authored prose.
    expect(md).toContain('# Design review');
    expect(md).toContain(REPORT_DRAFT.summary);
    expect(md).toContain('## Problems');
    expect(md).toContain('Nav overflows the viewport at 375px');
    expect(md).toContain('## Pros');
    expect(md).toContain('Consistent use of the accent color');

    // The design identity is RE-EXTRACTED from the real, live page — real colors/fonts, not the
    // model's guess (`background.ts` `reportIdentity`).
    expect(md).toContain('## Design tokens');
    expect(md).toContain('#0f172a');
    expect(md).toContain('Georgia');

    // The recorded edit's screenshot is embedded as an image link.
    expect(md).toContain('## Screenshots');
    expect(md).toContain('Recolor the CTA to the brand accent — after');
    expect(md).toContain(
      '![Recolor the CTA to the brand accent — after](data:image/png;base64,QUZURVI=)',
    );
  });
});

// A minimal MCP `task` backend (JSON-RPC 2.0 over Streamable HTTP, mirrors mcp.spec.ts's
// `stubMcpServer`): `tools/call` for `action:'create'` returns a queued handle; `action:'watch'`
// settles `ci_green` with a PR link built from the taskId, so two independently-tracked tasks get
// two distinguishable PR links.
function stubTaskServer(
  context: BrowserContext,
  url: string,
): { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  void context.route(url, async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({ status: 405, body: '' });
      return;
    }
    const body = JSON.parse(req.postData() ?? '{}') as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const reply = (result: unknown): Promise<void> =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      });
    switch (body.method) {
      case 'initialize':
        return reply({
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp', version: '1.0.0' },
        });
      case 'notifications/initialized':
        await route.fulfill({ status: 202, body: '' });
        return;
      case 'tools/list':
        return reply({
          tools: [
            {
              name: 'task',
              description: 'task',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
      case 'tools/call': {
        calls.push(body.params?.arguments ?? {});
        const args = body.params?.arguments ?? {};
        const payload =
          args.action === 'watch'
            ? {
                status: 'ci_green',
                prUrl: `https://gh.example/acme/storefront/pull/${args.taskId}`,
              }
            : { id: `task-${String(args.title)}`, status: 'queued' };
        return reply({
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          isError: false,
        });
      }
      default:
        await route.fulfill({ status: 404, body: '' });
    }
  });
  return { calls };
}

async function connectMcpServer(page: Page, label: string, url: string): Promise<void> {
  await page.getByRole('button', { name: 'MCP' }).click();
  await page.locator('#dz-mcp-label').fill(label);
  await page.locator('#dz-mcp-url').fill(url);
  await page.locator('.dz-mcp__add button[type="submit"]').click();
  const item = page.locator('.dz-mcp__item', { hasText: label });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'Connect' }).click();
  await expect(item.locator('.dz-mcp__status')).toHaveClass(/is-connected/, { timeout: 10_000 });
}

// Opens a second, test-only Port to the SW (the same `dz-sw-panel` Port TaskTimeline will read once
// mounted — src/entrypoints/sidepanel/stores/sw-stream.ts) and buffers every `task-status` push onto
// `window.__e2eTaskStatus`, so the timeline's actual data source is asserted directly.
async function watchTaskStatus(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __e2eTaskStatus: unknown[] }).__e2eTaskStatus = [];
    const port = chrome.runtime.connect({ name: 'dz-sw-panel' });
    port.onMessage.addListener((msg) => {
      const m = msg as { type?: string };
      if (m?.type === 'task-status') {
        (window as unknown as { __e2eTaskStatus: unknown[] }).__e2eTaskStatus.push(msg);
      }
    });
  });
}

function taskStatusEvents(page: Page): Promise<
  Array<{
    taskId: string;
    title: string;
    status: string;
    prUrl?: string;
    index: number;
    total: number;
  }>
> {
  return page.evaluate(
    () => (window as unknown as { __e2eTaskStatus: unknown[] }).__e2eTaskStatus,
  ) as ReturnType<typeof taskStatusEvents>;
}

test.describe('handoff: ship + send-report', () => {
  test('ship dispatches one task per problem to a mock MCP backend, each tracked to a PR link; send-report routes to the named backend', async ({
    context,
    openExtensionPage,
  }) => {
    await stubModels(context);
    await stubFixtures(context, { own: OWN_PAGE });
    const { streamRequests } = stubProvider(
      context,
      [
        toolCallStream('call-record', 'recordEdit', RECORD_EDIT_ARGS),
        textStream('Recolored your CTA to the brand accent green.'),
      ],
      REPORT_DRAFT,
    );

    const devUrl = `${FIXTURE_PREFIX}mcp-dev`;
    const devinUrl = `${FIXTURE_PREFIX}mcp-devin`;
    const dev = stubTaskServer(context, devUrl);
    const devin = stubTaskServer(context, devinUrl);

    const panel = await openExtensionPage('sidepanel.html');
    await configureProvider(panel);
    await connectMcpServer(panel, 'Acme Dev', devUrl);
    await connectMcpServer(panel, 'Devin', devinUrl);
    await panel.getByRole('button', { name: 'Chat' }).click();

    const sw = await serviceWorker(context);
    await sw.evaluate(
      () =>
        new Promise<void>((resolve) => {
          chrome.storage.local.set(
            { 'mcp:origin-repo': { 'openrouter.ai': 'acme/storefront' } },
            () => resolve(),
          );
        }),
    );

    const ownPage = await context.newPage();
    await ownPage.goto(`${FIXTURE_PREFIX}own`);
    await ownPage.bringToFront();

    await sendUserMessage(panel, 'Recolor the CTA and record it', 'copy');
    await expect.poll(() => streamRequests.length, { timeout: 20_000 }).toBe(2);

    await watchTaskStatus(panel);

    const problems = ['Nav overflows the viewport at 375px', 'CTA contrast is borderline on white'];
    const shipResult = (await panel.evaluate(
      (problems) => chrome.runtime.sendMessage({ type: 'ship', source: 'report', problems }),
      problems,
    )) as { ok: boolean; routed?: string; taskCount?: number };

    expect(shipResult.ok).toBe(true);
    expect(shipResult.routed).toBe('tasks');
    expect(shipResult.taskCount).toBe(2);

    await expect
      .poll(async () => (await taskStatusEvents(panel)).length, { timeout: 20_000 })
      .toBe(4);
    const events = await taskStatusEvents(panel);

    // Every task tracked independently to a terminal ci_green status with its own PR link.
    const byTitle = new Map(
      problems.map((title) => [title, events.filter((e) => e.title === title)]),
    );
    for (const title of problems) {
      const rows = byTitle.get(title) ?? [];
      expect(rows.map((r) => r.status)).toEqual(['queued', 'ci_green']);
      expect(rows.at(-1)?.prUrl).toContain('https://gh.example/acme/storefront/pull/');
      expect(rows.every((r) => r.total === 2)).toBe(true);
    }
    // Distinct PR links per task.
    const prUrls = new Set(events.filter((e) => e.prUrl).map((e) => e.prUrl));
    expect(prUrls.size).toBe(2);

    // Every create/watch round-trip landed on the developerz.ai stub, none on Devin's.
    expect(dev.calls.filter((c) => c.action === 'create')).toHaveLength(2);
    expect(devin.calls).toHaveLength(0);

    // "send to X": naming Devin explicitly routes the next handoff through ITS backend instead.
    const sendResult = (await panel.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'send-report', target: 'Devin' }),
    )) as { ok: boolean; routed?: string; taskCount?: number };

    expect(sendResult.ok).toBe(true);
    expect(sendResult.routed).toBe('tasks');
    expect(sendResult.taskCount).toBe(1); // no `problems[]` this time -> a single whole-brief task

    // The RPC replies before the fire-and-forget create+watch round-trip lands (mirrors the panel
    // store's own contract — `task-status` pushes, not the reply, are the source of truth), so wait
    // for its terminal status before inspecting which stub actually received the call.
    await expect
      .poll(async () => (await taskStatusEvents(panel)).length, { timeout: 20_000 })
      .toBe(6);
    expect(devin.calls.filter((c) => c.action === 'create')).toHaveLength(1);
    expect(dev.calls.filter((c) => c.action === 'create')).toHaveLength(2); // unchanged
  });
});
