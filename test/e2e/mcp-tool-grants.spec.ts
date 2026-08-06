import type { BrowserContext, Page } from '@playwright/test';
import { expect, openRoom, stubAuthProbe, test } from './fixtures';

// E2E: #120 per-tool opt-in for backend write-shaped tools, driven against a loaded, real
// Chromium. The stubbed MCP backend's catalog mixes a write-shaped tool (`deploy`) with a read
// tool (`get_status`) — no `task` verb (that one is hard-denied and never grantable).
//   (a) connect ⇒ the Write tools block renders `deploy` UNCHECKED, and the read tool is not
//       listed as a write tool;
//   (b) toggle on ⇒ the SW-persisted record (the same mcp-list reply the panel folds) carries
//       grantedTools: ['deploy'], and a panel reload re-renders the toggle checked (the grant
//       persists in chrome.storage.local);
//   (c) toggle off ⇒ the grant drops;
//   (d) the turn-side consequence: a design turn's offered tool list (the provider request's
//       `tools`) excludes `<id>__deploy` while ungranted and includes it once granted — while
//       the read tool rides throughout. Harness mirrors mcp-manage.spec.ts (real provider stub
//       + real MCP stub over the genuine wire protocol); only the LLM and MCP replies are canned.

const BASE_URL = 'https://openrouter.ai/api/v1';
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture-120/';
const MCP_URL = 'https://openrouter.ai/mcp-grants-stub/mcp';
const TOOLS = ['deploy', 'get_status'];

// --- provider + fixture stubs (mirrors mcp-manage.spec.ts) ---------------------

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

const OWN_PAGE =
  '<!doctype html><html><body style="background-color:#0f172a;color:#f8fafc">' +
  '<h1>My Hero</h1>' +
  '<button id="cta" style="background-color:#22c55e">Buy now</button>' +
  '</body></html>';

async function stubFixtures(context: BrowserContext): Promise<void> {
  await context.route(`${FIXTURE_PREFIX}**`, (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    if (key !== 'own') {
      route.fulfill({ status: 404, body: '' });
      return;
    }
    route.fulfill({ status: 200, contentType: 'text/html', body: OWN_PAGE });
  });
}

interface ChatMessage {
  role: string;
  content?: unknown;
}
interface ChatRequestBody {
  messages: ChatMessage[];
  stream?: boolean;
  // The offered tool list, OpenAI chat-completions shape — what the design turn's gate (#120)
  // actually filters. Captured so the test can assert the namespaced backend tools on it.
  tools?: Array<{ type?: string; function?: { name?: string } }>;
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

// Every streamed design turn gets the next canned text reply in `turns[]`; the request bodies
// are captured in `requests` for the offered-tools assertions.
function stubProvider(context: BrowserContext, turns: string[]): { requests: ChatRequestBody[] } {
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
    await route.fulfill({ status: 404, body: '' });
  });
  return { requests };
}

// --- MCP backend stub (mirrors mcp.spec.ts) -------------------------------------

// Minimal MCP backend: initialize/tools-list only — the grants flow never calls a tool (the
// stub model only ever replies text, so the offered `deploy` tool is never invoked).
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

// --- shared drivers ---------------------------------------------------------------

async function configureProvider(page: Page): Promise<void> {
  await openRoom(page, 'Settings');
  await page.locator('#dz-key').fill('sk-or-test-120');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model')).toHaveValue('test/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');
}

async function addMcpServer(page: Page, label: string, url: string): Promise<void> {
  await openRoom(page, 'MCP');
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
  writeTools: string[];
  grantedTools: string[];
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

// The grant toggle's accessible name, per mcp.writeTools.grant.ariaLabel in en.yml.
function deployToggle(item: ReturnType<Page['locator']>) {
  return item
    .locator('.dz-mcp__writes')
    .getByRole('checkbox', { name: 'Allow deploy in design turns on Grants MCP' });
}

test('MCP #120: write-tool grants render unchecked, persist across a reload, and revoke', async ({
  context,
  openExtensionPage,
}) => {
  await stubMcpServer(context, MCP_URL, TOOLS);
  const page = await openExtensionPage('sidepanel.html');

  await addMcpServer(page, 'Grants MCP', MCP_URL);
  const item = page.locator('.dz-mcp__item', { hasText: 'Grants MCP' });

  // Pre-connect the block is hidden: tools exist only post-connect.
  await expect(item.locator('.dz-mcp__writes')).toBeHidden();

  // (a) Connect ⇒ the Write tools block lists `deploy` UNCHECKED; the read tool is not a
  // write tool, and the bus record's write-shaped view matches the block.
  await item.getByRole('button', { name: 'Connect' }).click();
  await expect(item.locator('.dz-mcp__status')).toHaveClass(/is-connected/, { timeout: 10_000 });
  const writes = item.locator('.dz-mcp__writes');
  await expect(writes).toBeVisible();
  await expect(writes).toContainText('deploy');
  await expect(writes).not.toContainText('get_status');
  await expect(deployToggle(item)).not.toBeChecked();
  expect((await listServers(page))[0]?.writeTools).toEqual(['deploy']);
  expect((await listServers(page))[0]?.grantedTools).toEqual([]);

  // (b) Toggle on ⇒ the SW-persisted record carries the grant…
  await deployToggle(item).check();
  await expect(deployToggle(item)).toBeChecked();
  await expect.poll(async () => (await listServers(page))[0]?.grantedTools).toEqual(['deploy']);

  // …and a panel reload re-renders it checked — the grant lives in chrome.storage.local, not
  // in the panel's in-memory store.
  await page.reload();
  await openRoom(page, 'MCP');
  const itemAfter = page.locator('.dz-mcp__item', { hasText: 'Grants MCP' });
  await expect(itemAfter.locator('.dz-mcp__status')).toHaveClass(/is-connected/, {
    timeout: 10_000,
  });
  await expect(deployToggle(itemAfter)).toBeChecked();

  // (c) Toggle off ⇒ the grant drops, on the row and on the SW-persisted record alike.
  await deployToggle(itemAfter).uncheck();
  await expect(deployToggle(itemAfter)).not.toBeChecked();
  await expect.poll(async () => (await listServers(page))[0]?.grantedTools).toEqual([]);
});

test('MCP #120: a design turn offers a write-shaped tool only once granted', async ({
  context,
  openExtensionPage,
}) => {
  await stubModels(context);
  await stubFixtures(context);
  const { requests } = stubProvider(context, [
    textStream('First turn done.'),
    textStream('Second turn done.'),
  ]);
  await stubMcpServer(context, MCP_URL, TOOLS);

  const panel = await openExtensionPage('sidepanel.html');
  await configureProvider(panel);
  await addMcpServer(panel, 'Grants MCP', MCP_URL);
  const item = panel.locator('.dz-mcp__item', { hasText: 'Grants MCP' });
  await item.getByRole('button', { name: 'Connect' }).click();
  await expect(item.locator('.dz-mcp__status')).toHaveClass(/is-connected/, { timeout: 10_000 });

  // The names the model sees: `<sanitizedServerId>__<base>` (src/mcp/client.ts namespaceTool).
  const serverId = (await listServers(panel))[0]?.id ?? '';
  const ns = serverId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const deploy = `${ns}__deploy`;
  const read = `${ns}__get_status`;
  const streamed = () => requests.filter((r) => r.stream);
  const namesOf = (r: ChatRequestBody | undefined): Array<string | undefined> =>
    (r?.tools ?? []).map((t) => t.function?.name);

  // Start the session and park a design tab (mirrors mcp-manage.spec.ts's ship flow).
  const toggle = panel.locator('.dz-readiness__toggle');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(panel.locator('.dz-readiness__pill')).toHaveText(/Running…/);
  await openRoom(panel, 'Chat');

  const ownPage = await context.newPage();
  await ownPage.goto(`${FIXTURE_PREFIX}own`);
  await ownPage.bringToFront();

  // (d) UNGRANTED: the turn's offered tools exclude `deploy` — while the read tool rides,
  // proving the backend's merge ran and the gate (not a failed connect) did the excluding.
  await panel.getByPlaceholder('Tell the agent what to change…').fill('First turn, ungranted');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => streamed().length, { timeout: 20_000 }).toBe(1);
  expect(namesOf(streamed()[0])).toContain(read);
  expect(namesOf(streamed()[0])).not.toContain(deploy);

  // Grant via the panel toggle (the same RPC the user drives), then the NEXT turn's merge
  // picks the grant up (background.ts: it takes effect on the next toolsFor call).
  await openRoom(panel, 'MCP');
  await deployToggle(panel.locator('.dz-mcp__item', { hasText: 'Grants MCP' })).check();
  await expect.poll(async () => (await listServers(panel))[0]?.grantedTools).toEqual(['deploy']);

  await openRoom(panel, 'Chat');
  await panel.getByPlaceholder('Tell the agent what to change…').fill('Second turn, granted');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => streamed().length, { timeout: 20_000 }).toBe(2);
  expect(namesOf(streamed()[1])).toContain(deploy);
  expect(namesOf(streamed()[1])).toContain(read);
});
