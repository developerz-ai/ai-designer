import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';

// Stub a minimal MCP backend (JSON-RPC 2.0 over Streamable HTTP — modelcontextprotocol.io
// "basic/transports") under `openrouter.ai`, whose origin is already granted via the
// manifest's static `host_permissions` (wxt.config.ts). That sidesteps the un-drivable
// native `chrome.permissions.request` prompt a genuinely new host would need — see
// settings.spec.ts's "Custom base URL" test for the same trick. `src/mcp/client.ts` opens
// the *real* `@ai-sdk/mcp` client against this URL (background.ts wires no test double), so
// answering its wire calls (`initialize` -> ack -> `tools/list`) exercises the genuine
// protocol, not a mock of our own code. Routing on the persistent context intercepts the
// service worker's own fetches the same way it intercepts `/models` in settings.spec.ts.
async function stubMcpServer(context: BrowserContext, url: string, tools: string[]): Promise<void> {
  await context.route(url, async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      // Declines the best-effort inbound SSE stream (405 = "not supported here") — the
      // POST/JSON-RPC pair below is everything this test needs.
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
        await route.fulfill({ status: 202, body: '' }); // notification: no reply body expected
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

test('MCP: add a stubbed server, connect, and list its discovered tools', async ({
  context,
  openExtensionPage,
}) => {
  const url = 'https://openrouter.ai/mcp-test-stub/mcp';
  await stubMcpServer(context, url, ['create_task', 'get_task']);
  const page = await openExtensionPage('sidepanel.html');

  await page.getByRole('button', { name: 'MCP' }).click();
  await page.locator('#dz-mcp-label').fill('Mock MCP');
  await page.locator('#dz-mcp-url').fill(url);
  await page.locator('.dz-mcp__add button[type="submit"]').click();

  const item = page.locator('.dz-mcp__item', { hasText: 'Mock MCP' });
  await expect(item).toBeVisible();
  await expect(item.locator('.dz-mcp__status')).toHaveClass(/is-disconnected/);

  await item.getByRole('button', { name: 'Connect' }).click();
  await expect(item.locator('.dz-mcp__status')).toHaveClass(/is-connected/, { timeout: 10_000 });
  await expect(item.locator('.dz-mcp__tools')).toHaveText('2 tools');
});

// OAuth: the doc (`02-mcp-servers.md` "E2E") is explicit — mock/skip
// `chrome.identity.launchWebAuthFlow`, assert the authorization URL it's given is correctly
// built (PKCE per RFC 7636), and never attempt to drive the resulting native consent screen.
// Empirically (verified against a loaded build), that native flow opens a window outside the
// persistent context's regular tab/page set — `context.route` never sees its navigation, and
// waiting for one hangs until the test times out. So this mocks `launchWebAuthFlow` itself:
// `sw.evaluate` runs in the service worker's own global (real CDP `Runtime.evaluate` on that
// target, not a page), replacing the one native call the harness can't drive with a capture
// that immediately resolves as "cancelled" — the rest of the flow (form -> RPC -> PKCE
// derivation -> the SW handing that URL to `launchWebAuthFlow`) all runs for real.
test('MCP OAuth: builds the PKCE authorization URL, without driving the consent dialog', async ({
  context,
  openExtensionPage,
}) => {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await sw.evaluate(() => {
    const global = globalThis as unknown as { __e2eCapturedAuthUrl?: string };
    global.__e2eCapturedAuthUrl = undefined;
    chrome.identity.launchWebAuthFlow = ((details: { url: string }) => {
      global.__e2eCapturedAuthUrl = details.url;
      return Promise.resolve(undefined); // simulate the user cancelling — deterministic, no window
    }) as typeof chrome.identity.launchWebAuthFlow;
  });

  const page = await openExtensionPage('sidepanel.html');
  await page.getByRole('button', { name: 'MCP' }).click();

  await page.locator('#dz-mcp-label').fill('OAuth Server');
  await page.locator('#dz-mcp-url').fill('https://openrouter.ai/mcp-oauth-stub/mcp');
  await page.locator('#dz-mcp-authkind').selectOption('oauth');
  await page.locator('.dz-mcp__add button[type="submit"]').click();

  const item = page.locator('.dz-mcp__item', { hasText: 'OAuth Server' });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'Authorize' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#dz-auth-authz').fill('https://mock-oauth.example.com/authorize');
  await dialog.locator('#dz-auth-token').fill('https://mock-oauth.example.com/token');
  await dialog.locator('#dz-auth-client').fill('test-client-id');
  await dialog.locator('.dz-authdialog__submit').click();

  // The cancelled flow surfaces as an error in the dialog — proof the round trip (submit ->
  // mcp-auth-start RPC -> startOAuth -> launchWebAuthFlow) completed rather than hanging.
  await expect(dialog.locator('.dz-authdialog__error')).toHaveText(/cancelled/i);

  // Proves src/mcp/auth.ts's buildAuthorizationUrl/deriveCodeChallenge ran for real inside
  // the service worker and chrome.identity.launchWebAuthFlow was handed the right URL.
  const captured = await sw.evaluate(
    () => (globalThis as unknown as { __e2eCapturedAuthUrl?: string }).__e2eCapturedAuthUrl,
  );
  const url = new URL(captured ?? '');
  expect(url.origin + url.pathname).toBe('https://mock-oauth.example.com/authorize');
  const params = Object.fromEntries(url.searchParams);
  expect(params.response_type).toBe('code');
  expect(params.client_id).toBe('test-client-id');
  expect(params.code_challenge_method).toBe('S256');
  expect(params.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(params.state).toBeTruthy();
  expect(params.redirect_uri).toContain('chromiumapp.org');
});
