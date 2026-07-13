// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { headerResolverFor, saveApiKey, startOAuth } from '@/mcp/auth';
import type { McpClientFactory, McpConnectionSpec } from '@/mcp/client';
import { McpManager } from '@/mcp/manager';
import { getServer, listServers, removeServer, type StoredServer, saveServer } from '@/mcp/store';
import { ensureHostAccess } from '@/shared/host-permissions';
import type { McpOAuthConfig, McpServer, PanelToSw } from '@/shared/messages';
import { McpListResult, McpServerResult, OkResult } from '@/shared/messages';

// Integration: the panel<->SW MCP RPCs (mcp-add/remove/list/connect/auth-start/status),
// exercised through the *real* cooperating modules (mcp/store + mcp/manager + mcp/auth +
// host-permissions) the way background.ts wires them, end to end — real WebCrypto (node
// env), a real (fake) IndexedDB, fake chrome.storage.local/permissions/identity, and a
// fake MCP client factory (no real HTTP server) so `connect()`/`toolsFor()` are exercised.
//
// background.ts itself imports the WXT-virtual `#imports` module, which only resolves
// inside a WXT-built bundle — not plain Vitest (see test/integration/provider-settings.test.ts
// for the same constraint). So this test reproduces the handler's mcp-* case sequence
// directly against the real modules, mirroring background.ts's `handle()` cases 1:1,
// rather than importing the entrypoint.

function installChromeFakes(opts: { grantedOrigins?: string[] } = {}): void {
  const storage = new Map<string, unknown>();
  const grantedOrigins = new Set(opts.grantedOrigins ?? []);
  const local = {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const names = keys == null ? [...storage.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (storage.has(name)) out[name] = storage.get(name);
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [name, value] of Object.entries(items)) storage.set(name, value);
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) storage.delete(k);
      return Promise.resolve();
    },
  };
  const permissions = {
    contains: (p: { origins?: string[] }) =>
      Promise.resolve((p.origins ?? []).every((o) => grantedOrigins.has(o))),
    request: (p: { origins?: string[] }) => {
      for (const o of p.origins ?? []) grantedOrigins.add(o); // this suite always grants
      return Promise.resolve(true);
    },
  };
  const identity = {
    launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
      const state = new URL(url).searchParams.get('state');
      return `https://ext.chromiumapp.org/cb?code=auth-code-xyz&state=${state}`;
    }),
    getRedirectURL: () => 'https://ext.chromiumapp.org/cb',
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { local }, permissions, identity };
}

const OAUTH: McpOAuthConfig = {
  authorizationEndpoint: 'https://auth.example.com/authorize',
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'client-123',
};

/** A fake MCP client factory — no real HTTP server; branch on url if a test needs to. */
function fakeMcpFactory(tools: Record<string, unknown> = { task: {} }): McpClientFactory {
  return vi.fn(async () => ({
    tools: async () => tools as never,
    close: async () => {},
  }));
}

// Rebuilds the piece of SW-lifetime state background.ts closes over for the mcp-* cases,
// so each test gets a fresh manager/oauth cache like a fresh service worker would.
function makeHandlers(connect: McpClientFactory) {
  const mcpManager = new McpManager({ connect, idleMs: 0 });
  const oauthConfigs = new Map<string, McpOAuthConfig>();

  function mcpSpec(stored: StoredServer): McpConnectionSpec {
    return {
      id: stored.id,
      url: stored.url,
      getHeaders: headerResolverFor({
        id: stored.id,
        authKind: stored.authKind,
        oauth: oauthConfigs.get(stored.id),
      }),
    };
  }

  function toBusServer(stored: StoredServer): McpServer {
    const health = mcpManager.health(stored.id);
    return {
      id: stored.id,
      label: stored.label,
      url: stored.url,
      transport: stored.transport,
      authKind: stored.authKind,
      status: health?.status ?? 'disconnected',
      toolCount: health?.toolCount ?? 0,
      tools: health?.tools ?? [],
      error: health?.error,
    };
  }

  // Mirrors background.ts's `case 'mcp-add'`.
  async function handleAdd(msg: PanelToSw & { type: 'mcp-add' }) {
    const access = await ensureHostAccess(msg.url);
    if (!access.ok) return McpServerResult.parse({ ok: false, error: access.error });
    const stored = await saveServer({
      id: crypto.randomUUID(),
      label: msg.label,
      url: msg.url,
      transport: msg.transport,
      authKind: msg.authKind,
    });
    mcpManager.register(mcpSpec(stored));
    return McpServerResult.parse({ ok: true, server: toBusServer(stored) });
  }

  // Mirrors background.ts's `case 'mcp-remove'`.
  async function handleRemove(msg: PanelToSw & { type: 'mcp-remove' }) {
    await mcpManager.unregister(msg.id);
    oauthConfigs.delete(msg.id);
    await removeServer(msg.id);
    return OkResult.parse({ ok: true });
  }

  // Mirrors background.ts's `case 'mcp-list'`.
  async function handleList() {
    const servers = (await listServers()).map(toBusServer);
    return McpListResult.parse({ ok: true, servers });
  }

  // Mirrors background.ts's `case 'mcp-connect'`.
  async function handleConnect(msg: PanelToSw & { type: 'mcp-connect' }) {
    const stored = await getServer(msg.id);
    if (!stored)
      return McpServerResult.parse({ ok: false, error: `Unknown MCP server: ${msg.id}` });
    if (!mcpManager.has(msg.id)) mcpManager.register(mcpSpec(stored));
    await mcpManager.connect(msg.id);
    return McpServerResult.parse({ ok: true, server: toBusServer(stored) });
  }

  // Mirrors background.ts's `case 'mcp-auth-start'`.
  async function handleAuthStart(msg: PanelToSw & { type: 'mcp-auth-start' }) {
    const stored = await getServer(msg.id);
    if (!stored)
      return McpServerResult.parse({ ok: false, error: `Unknown MCP server: ${msg.id}` });
    try {
      if (msg.authKind === 'apikey') {
        await saveApiKey(msg.id, msg.apiKey);
      } else {
        oauthConfigs.set(msg.id, msg.oauth);
        await startOAuth(msg.id, msg.oauth);
      }
    } catch (err) {
      return McpServerResult.parse({ ok: false, error: String(err) });
    }
    const next = await saveServer({ ...stored, authKind: msg.authKind });
    mcpManager.register(mcpSpec(next));
    await mcpManager.connect(msg.id);
    return McpServerResult.parse({ ok: true, server: toBusServer(next) });
  }

  return { mcpManager, handleAdd, handleRemove, handleList, handleConnect, handleAuthStart };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
});

describe('integration: mcp-add -> mcp-list -> mcp-connect through the bus', () => {
  it('adds a server (requesting host access), lists it, then connects and discovers tools', async () => {
    installChromeFakes();
    const { handleAdd, handleList, handleConnect } = makeHandlers(
      fakeMcpFactory({ create_task: {}, get_task: {} }),
    );

    const added = await handleAdd({
      type: 'mcp-add',
      label: 'ai-dev',
      url: 'https://ai-dev.example.com/mcp',
    });
    expect(added.ok).toBe(true);
    expect(added.server).toMatchObject({
      label: 'ai-dev',
      url: 'https://ai-dev.example.com/mcp',
      transport: 'http',
      authKind: 'none',
      status: 'disconnected',
      toolCount: 0,
    });
    const id = added.server?.id;
    if (!id) throw new Error('mcp-add did not return a server id');

    const listed = await handleList();
    expect(listed.servers).toHaveLength(1);
    expect(listed.servers?.[0]?.id).toBe(id);

    const connected = await handleConnect({ type: 'mcp-connect', id });
    expect(connected.ok).toBe(true);
    expect(connected.server).toMatchObject({
      status: 'connected',
      toolCount: 2,
      tools: [`${id.replace(/[^a-zA-Z0-9_-]/g, '_')}__create_task`, expect.any(String)],
    });

    // The permission grant is persisted, and the origin host access is now known-good.
    expect(await ensureHostAccess('https://ai-dev.example.com/mcp')).toEqual({ ok: true });
  });

  it('denies the add and persists nothing when the host grant is refused', async () => {
    installChromeFakes();
    (globalThis as unknown as { chrome: typeof chrome }).chrome.permissions.request = (() =>
      Promise.resolve(false)) as typeof chrome.permissions.request;
    const { handleAdd } = makeHandlers(fakeMcpFactory());

    const result = await handleAdd({
      type: 'mcp-add',
      label: 'blocked',
      url: 'https://blocked.example.com/mcp',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('https://blocked.example.com/*');
    expect(await listServers()).toEqual([]);
  });

  it('mcp-connect on an unknown id returns ok:false without throwing', async () => {
    installChromeFakes();
    const { handleConnect } = makeHandlers(fakeMcpFactory());
    const result = await handleConnect({ type: 'mcp-connect', id: 'missing' });
    expect(result).toEqual({ ok: false, error: 'Unknown MCP server: missing', server: undefined });
  });

  it('isolates a failing connect: status degrades to error, server + record still list', async () => {
    installChromeFakes();
    const connect = vi.fn(async () => {
      throw new Error('401 unauthorized');
    }) as unknown as McpClientFactory;
    const { handleAdd, handleConnect } = makeHandlers(connect);

    const added = await handleAdd({ type: 'mcp-add', label: 'flaky', url: 'https://flaky/mcp' });
    const id = added.server?.id;
    if (!id) throw new Error('mcp-add did not return a server id');

    const connected = await handleConnect({ type: 'mcp-connect', id });
    expect(connected.ok).toBe(true); // the RPC itself never throws
    expect(connected.server).toMatchObject({ status: 'error', error: '401 unauthorized' });
  });
});

describe('integration: mcp-remove tears down the connection and purges secrets', () => {
  it('removes the persisted record and clears any stored API key', async () => {
    installChromeFakes();
    const { handleAdd, handleAuthStart, handleRemove, handleList } = makeHandlers(fakeMcpFactory());

    const added = await handleAdd({ type: 'mcp-add', label: 'S', url: 'https://s/mcp' });
    const id = added.server?.id;
    if (!id) throw new Error('mcp-add did not return a server id');
    await handleAuthStart({ type: 'mcp-auth-start', id, authKind: 'apikey', apiKey: 'secret-1' });

    const removed = await handleRemove({ type: 'mcp-remove', id });
    expect(removed).toEqual({ ok: true, error: undefined });
    expect((await handleList()).servers).toEqual([]);
    expect(await getServer(id)).toBeNull();
  });
});

describe('integration: mcp-auth-start (apikey + oauth) then reconnect', () => {
  it('apikey path: stores the key, flips authKind, and reconnects with a Bearer header', async () => {
    installChromeFakes();
    const connect = vi.fn(async (config: { transport: { headers?: Record<string, string> } }) => ({
      tools: async () => {
        expect(config.transport.headers).toEqual({ Authorization: 'Bearer admin-key-abc' });
        return { task: {} };
      },
      close: async () => {},
    })) as unknown as McpClientFactory;
    const { handleAdd, handleAuthStart } = makeHandlers(connect);

    const added = await handleAdd({ type: 'mcp-add', label: 'S', url: 'https://s/mcp' });
    const id = added.server?.id;
    if (!id) throw new Error('mcp-add did not return a server id');
    expect(added.server?.authKind).toBe('none');

    const authed = await handleAuthStart({
      type: 'mcp-auth-start',
      id,
      authKind: 'apikey',
      apiKey: 'admin-key-abc',
    });
    expect(authed.ok).toBe(true);
    expect(authed.server).toMatchObject({ authKind: 'apikey', status: 'connected', toolCount: 1 });

    const stored = await getServer(id);
    expect(stored?.authKind).toBe('apikey');
  });

  it('oauth path: runs the PKCE flow, persists the token, flips authKind, and reconnects', async () => {
    installChromeFakes();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'acc-1', expires_in: 3600, token_type: 'Bearer' }),
      })),
    );
    const connect = vi.fn(async (config: { transport: { headers?: Record<string, string> } }) => ({
      tools: async () => {
        expect(config.transport.headers).toEqual({ Authorization: 'Bearer acc-1' });
        return { task: {} };
      },
      close: async () => {},
    })) as unknown as McpClientFactory;
    const { handleAdd, handleAuthStart } = makeHandlers(connect);

    const added = await handleAdd({ type: 'mcp-add', label: 'S', url: 'https://s/mcp' });
    const id = added.server?.id;
    if (!id) throw new Error('mcp-add did not return a server id');

    const authed = await handleAuthStart({
      type: 'mcp-auth-start',
      id,
      authKind: 'oauth',
      oauth: OAUTH,
    });
    expect(authed.ok).toBe(true);
    expect(authed.server).toMatchObject({ authKind: 'oauth', status: 'connected', toolCount: 1 });

    const stored = await getServer(id);
    expect(stored?.authKind).toBe('oauth');
    vi.unstubAllGlobals();
  });

  it('surfaces an auth failure without mutating the stored authKind', async () => {
    installChromeFakes();
    (globalThis as unknown as { chrome: typeof chrome }).chrome.identity.launchWebAuthFlow = vi.fn(
      async () => undefined,
    ) as typeof chrome.identity.launchWebAuthFlow;
    const { handleAdd, handleAuthStart } = makeHandlers(fakeMcpFactory());

    const added = await handleAdd({ type: 'mcp-add', label: 'S', url: 'https://s/mcp' });
    const id = added.server?.id;
    if (!id) throw new Error('mcp-add did not return a server id');

    const authed = await handleAuthStart({
      type: 'mcp-auth-start',
      id,
      authKind: 'oauth',
      oauth: OAUTH,
    });
    expect(authed.ok).toBe(false);
    expect(authed.error).toMatch(/cancel/i);
    expect((await getServer(id))?.authKind).toBe('none');
  });

  it('mcp-auth-start on an unknown id returns ok:false without throwing', async () => {
    installChromeFakes();
    const { handleAuthStart } = makeHandlers(fakeMcpFactory());
    const result = await handleAuthStart({
      type: 'mcp-auth-start',
      id: 'missing',
      authKind: 'apikey',
      apiKey: 'k',
    });
    expect(result).toEqual({ ok: false, error: 'Unknown MCP server: missing', server: undefined });
  });
});
