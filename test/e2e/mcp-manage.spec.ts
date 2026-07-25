import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// E2E: the #17/#20 panel surface, driven against a loaded, real Chromium.
//   (a) the per-backend enable/disable switch on an MCP server row (#17) — the toggle flips the
//       SW-persisted record (asserted over the same mcp-list RPC the panel itself reads), and the
//       SW refuses mcp-connect while disabled.
//   (b) the one-click-Ship origin→repo mapping (#20): Ship with no mapping falls back to a brief
//       download and ShipBar surfaces the INLINE mapping form; saving it re-fires Ship, which now
//       routes task(create) to the stubbed backend. Harness mirrors handoff.spec.ts (real provider
//       stub + real MCP stub + real fixture page); only the LLM and MCP wire replies are canned.

const BASE_URL = 'https://openrouter.ai/api/v1';
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture-20/';

// --- provider + fixture stubs (mirrors handoff.spec.ts) ---------------------

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

// Streaming tool-loop turns are served in order from `turns[]`; the report pass's non-streaming
// call gets one canned draft (handoff.spec.ts's `stubProvider`, incl. the JSON body it expects).
function stubProvider(
  context: BrowserContext,
  turns: string[],
  reportDraft: Record<string, unknown>,
): { requests: ChatRequestBody[] } {
  const requests: ChatRequestBody[] = [];
  void context.route(`${BASE_URL}/chat/completions`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as ChatRequestBody;
    requests.push(body);
    if (body.stream) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: turns[requests.filter((r) => r.stream).length - 1] ?? textStream('(extra turn)'),
      });
      return;
    }
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
  return { requests };
}

// --- MCP backend stubs (mirrors mcp.spec.ts + handoff.spec.ts) --------------

// Minimal MCP backend: initialize/tools-list only (test a connects, never calls a tool).
async function stubMcpServer(context: BrowserContext, url: string, tools: string[]): Promise<void> {
  await context.route(url, async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({ status: 405, body: '' });
      return;
    }
    const body = JSON.parse(req.postData() ?? '{}') as { id?: number; method?: string };
    switch (body.method) {
      case 'initialize':
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'mock-mcp', version: '1.0.0' },
            },
          }),
        });
        return;
      case 'notifications/initialized':
        await route.fulfill({ status: 202, body: '' });
        return;
      case 'tools/list':
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: tools.map((name) => ({
                name,
                description: name,
                inputSchema: { type: 'object', properties: {} },
              })),
            },
          }),
        });
        return;
      default:
        await route.fulfill({ status: 404, body: '' });
    }
  });
}

// A `task` backend: create returns a queued handle, watch settles ci_green (handoff.spec.ts).
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

// --- shared drivers ----------------------------------------------------------

async function configureProvider(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-key').fill('sk-or-test-20');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model option')).toHaveText(['Test Vision']);
  await page.locator('#dz-model').selectOption('test/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');
}

async function addMcpServer(page: Page, label: string, url: string): Promise<void> {
  await page.getByRole('button', { name: 'MCP' }).click();
  await page.locator('#dz-mcp-label').fill(label);
  await page.locator('#dz-mcp-url').fill(url);
  await page.locator('.dz-mcp__add button[type="submit"]').click();
  const item = page.locator('.dz-mcp__item', { hasText: label });
  await expect(item).toBeVisible();
}

interface BusServer {
  id: string;
  label: string;
  enabled: boolean;
  status: string;
}

function listServers(page: Page): Promise<BusServer[]> {
  return page.evaluate(async () => {
    const r = (await chrome.runtime.sendMessage({ type: 'mcp-list' })) as {
      ok: boolean;
      servers?: BusServer[];
    };
    return r.servers ?? [];
  });
}

test('MCP #17: the row toggle disables/enables a backend, and the SW refuses connect while disabled', async ({
  context,
  openExtensionPage,
}) => {
  const url = 'https://openrouter.ai/mcp-manage-stub/mcp';
  await stubMcpServer(context, url, ['task']);
  const page = await openExtensionPage('sidepanel.html');

  await addMcpServer(page, 'Mock MCP', url);
  const item = page.locator('.dz-mcp__item', { hasText: 'Mock MCP' });

  // Connect first so the disable also proves the SW tears a LIVE connection down.
  await item.getByRole('button', { name: 'Connect' }).click();
  await expect(item.locator('.dz-mcp__status')).toHaveClass(/is-connected/, { timeout: 10_000 });

  const toggle = item.getByRole('checkbox', { name: 'Enable or disable Mock MCP' });
  await expect(toggle).toBeChecked();

  // Disable → the row mutes, Connect hides, the live connection is torn down, and the
  // SW-persisted record (the same mcp-list reply the panel folds) carries enabled:false.
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(item).toHaveClass(/is-disabled/);
  await expect(item.getByRole('button', { name: 'Connect' })).toBeHidden();
  await expect(item.locator('.dz-mcp__status')).toHaveClass(/is-disconnected/);
  await expect.poll(async () => (await listServers(page))[0]?.enabled).toBe(false);

  // The SW-side gate: mcp-connect on a disabled server errors instead of connecting.
  const refused = (await page.evaluate(async () => {
    const list = (await chrome.runtime.sendMessage({ type: 'mcp-list' })) as {
      servers?: Array<{ id: string }>;
    };
    return chrome.runtime.sendMessage({ type: 'mcp-connect', id: list.servers?.[0]?.id });
  })) as { ok: boolean; error?: string };
  expect(refused.ok).toBe(false);
  expect(refused.error).toMatch(/disabled/);

  // Re-enable → the row restores and Connect is offered again.
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(item).not.toHaveClass(/is-disabled/);
  await expect(item.getByRole('button', { name: 'Connect' })).toBeVisible();
  await expect.poll(async () => (await listServers(page))[0]?.enabled).toBe(true);
});

const RECORD_EDIT_ARGS = {
  intent: 'Recolor the CTA to the brand accent',
  selector: { value: '#cta', strategy: 'id' },
  changes: [{ prop: 'background-color', before: '#e5e7eb', after: '#22c55e' }],
  frameworkHints: [],
};

const OWN_PAGE =
  '<!doctype html><html><body style="background-color:#0f172a;color:#f8fafc">' +
  '<h1>My Hero</h1>' +
  '<button id="cta" style="background-color:#22c55e">Buy now</button>' +
  '</body></html>';

const REPORT_DRAFT = {
  summary: 'Recolored the CTA to the brand accent.',
  findings: ['CTA now uses the brand accent green'],
  problems: ['CTA contrast is borderline on white'],
  pros: ['Consistent use of the accent color'],
  cons: ['Type scale is inconsistent'],
  recommendations: ['Adopt an 8px spacing grid'],
};

test('Ship #20: no mapping → inline mapping form → save & Ship again routes task(create) to the backend', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context, { own: OWN_PAGE });
  const { requests } = stubProvider(
    context,
    [
      toolCallStream('call-record', 'recordEdit', RECORD_EDIT_ARGS),
      textStream('Recolored your CTA to the brand accent green.'),
    ],
    REPORT_DRAFT,
  );
  const devUrl = `${FIXTURE_PREFIX}mcp-dev`;
  const dev = stubTaskServer(context, devUrl);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);
  await addMcpServer(panel, 'Acme Dev', devUrl);
  const item = panel.locator('.dz-mcp__item', { hasText: 'Acme Dev' });
  await item.getByRole('button', { name: 'Connect' }).click();
  await expect(item.locator('.dz-mcp__status')).toHaveClass(/is-connected/, { timeout: 10_000 });

  // Start + one recorded turn so there is a changeset to ship (mirrors chat-streaming.spec.ts).
  const toggle = panel.locator('.dz-readiness__toggle');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(panel.locator('.dz-readiness__pill')).toHaveText(/Running…/);
  await panel.getByRole('button', { name: 'Chat' }).click();

  const ownPage = await context.newPage();
  await ownPage.goto(`${FIXTURE_PREFIX}own`);
  await ownPage.bringToFront();

  await panel
    .getByPlaceholder('Tell the agent what to change…')
    .fill('Recolor the CTA and record it');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => requests.filter((r) => r.stream).length, { timeout: 20_000 }).toBe(2);
  await expect(panel.locator('.dz-message--assistant').last()).toContainText('Recolored your CTA');

  // Ship with NO mapping: the SW falls back to a brief download with the no-repo reason, and
  // ShipBar surfaces the inline mapping form for the current design tab's origin.
  await panel.getByRole('button', { name: 'Ship', exact: true }).click();
  await expect(panel.locator('.dz-shipbar__hint')).toContainText('No repo is mapped', {
    timeout: 20_000,
  });
  const mapForm = panel.locator('.dz-shipbar .dz-originrepo');
  await expect(mapForm).toBeVisible();
  await expect(mapForm.locator('.dz-originrepo__origin')).toHaveText('openrouter.ai');
  expect(dev.calls).toHaveLength(0); // nothing dispatched yet

  // One-click promise: save the mapping; Ship re-fires and now routes to the backend.
  await mapForm.locator('.dz-originrepo__repo').fill('acme/storefront');
  await mapForm.getByRole('button', { name: 'Save mapping & Ship again' }).click();

  await expect
    .poll(() => dev.calls.filter((c) => c.action === 'create').length, { timeout: 20_000 })
    .toBe(1);
  const create = dev.calls.find((c) => c.action === 'create');
  expect(create?.repo).toBe('acme/storefront');
  await expect
    .poll(() => dev.calls.filter((c) => c.action === 'watch').length, { timeout: 20_000 })
    .toBe(1);

  // The mapping persisted: the MCP panel's origin→repo section lists it.
  await panel.getByRole('button', { name: 'MCP' }).click();
  const row = panel.locator('.dz-originrepo__row', { hasText: 'openrouter.ai' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('acme/storefront');
});
