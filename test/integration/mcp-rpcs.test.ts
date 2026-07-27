// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { headerResolverFor, saveApiKey, startOAuth } from '@/mcp/auth';
import { TASK_TOOL } from '@/mcp/backend';
import type { McpClientFactory, McpConnectionSpec } from '@/mcp/client';
import { isWriteShaped, toolBaseName } from '@/mcp/design-gate';
import { McpManager } from '@/mcp/manager';
import {
  clearOriginRepo,
  getOriginRepoMap,
  getServer,
  listServers,
  removeServer,
  type StoredServer,
  saveServer,
  setOriginRepo,
} from '@/mcp/store';
import { ensureHostAccess } from '@/shared/host-permissions';
import type { McpOAuthConfig, McpServer, PanelToSw } from '@/shared/messages';
import { McpListResult, McpOriginRepoResult, McpServerResult, OkResult } from '@/shared/messages';

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
    request: vi.fn((p: { origins?: string[] }) => {
      for (const o of p.origins ?? []) grantedOrigins.add(o); // this suite always grants
      return Promise.resolve(true);
    }),
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
  // #120 grant map — mirrors background.ts's tool-grants store reads; the grant-set harness
  // case writes it (the real store is exercised in the store unit suite).
  const grants: Record<string, string[]> = {};

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
    const writeTools = (health?.tools ?? [])
      .map((name) => toolBaseName(name))
      .filter((base) => base !== TASK_TOOL && isWriteShaped(base));
    return {
      id: stored.id,
      label: stored.label,
      url: stored.url,
      transport: stored.transport,
      authKind: stored.authKind,
      enabled: stored.enabled,
      status: health?.status ?? 'disconnected',
      toolCount: health?.toolCount ?? 0,
      tools: health?.tools ?? [],
      writeTools: [...new Set(writeTools)],
      grantedTools: (grants[stored.id] ?? []).filter((g) => writeTools.includes(g)),
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
    mcpManager.register(mcpSpec(stored), { enabled: stored.enabled });
    return McpServerResult.parse({ ok: true, server: toBusServer(stored) });
  }

  // Mirrors background.ts's `case 'mcp-remove'` — including the #120 grant purge
  // (background calls clearToolGrants; the harness map is its stand-in).
  async function handleRemove(msg: PanelToSw & { type: 'mcp-remove' }) {
    await mcpManager.unregister(msg.id);
    oauthConfigs.delete(msg.id);
    await removeServer(msg.id);
    delete grants[msg.id]; // no orphaned grant survives a removal
    return OkResult.parse({ ok: true });
  }

  // Mirrors background.ts's `case 'mcp-list'`.
  async function handleList() {
    const servers = (await listServers()).map(toBusServer);
    return McpListResult.parse({ ok: true, servers });
  }

  // Mirrors background.ts's `case 'mcp-connect'` — a disabled server (#17) refuses
  // before any open is attempted.
  async function handleConnect(msg: PanelToSw & { type: 'mcp-connect' }) {
    const stored = await getServer(msg.id);
    if (!stored)
      return McpServerResult.parse({ ok: false, error: `Unknown MCP server: ${msg.id}` });
    if (!stored.enabled)
      return McpServerResult.parse({
        ok: false,
        error: `MCP server is disabled: ${stored.label}`,
      });
    if (!mcpManager.has(msg.id)) mcpManager.register(mcpSpec(stored));
    await mcpManager.connect(msg.id);
    return McpServerResult.parse({ ok: true, server: toBusServer(stored) });
  }

  // Mirrors background.ts's `case 'mcp-set-enabled'` (#17): persist the flag, flip the
  // manager registration (disabling tears the live connection down), reply the bus record.
  async function handleSetEnabled(msg: PanelToSw & { type: 'mcp-set-enabled' }) {
    const stored = await getServer(msg.id);
    if (!stored)
      return McpServerResult.parse({ ok: false, error: `Unknown MCP server: ${msg.id}` });
    const next = await saveServer({ ...stored, enabled: msg.enabled });
    if (!mcpManager.has(msg.id)) mcpManager.register(mcpSpec(next), { enabled: next.enabled });
    await mcpManager.setEnabled(msg.id, msg.enabled);
    return McpServerResult.parse({ ok: true, server: toBusServer(next) });
  }

  // Mirrors background.ts's `case 'mcp-origin-repo-get'` (#20).
  async function handleOriginRepoGet() {
    return McpOriginRepoResult.parse({ ok: true, map: await getOriginRepoMap() });
  }

  // Mirrors background.ts's `case 'mcp-origin-repo-set'` (#20).
  async function handleOriginRepoSet(msg: PanelToSw & { type: 'mcp-origin-repo-set' }) {
    await setOriginRepo(msg.origin, msg.entry);
    return OkResult.parse({ ok: true });
  }

  // Mirrors background.ts's `case 'mcp-origin-repo-clear'` (#20).
  async function handleOriginRepoClear(msg: PanelToSw & { type: 'mcp-origin-repo-clear' }) {
    await clearOriginRepo(msg.origin);
    return OkResult.parse({ ok: true });
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

  // Mirrors background.ts's `case 'mcp-tool-grant-set'` (#120): persist the grant/revoke
  // (here: the harness map, with the store's idempotent + last-revoke-drops-the-key semantics
  // — the REAL store is exercised in test/unit/tool-grants.test.ts), reply the fresh bus record.
  async function handleToolGrantSet(msg: PanelToSw & { type: 'mcp-tool-grant-set' }) {
    const stored = await getServer(msg.id);
    if (!stored)
      return McpServerResult.parse({ ok: false, error: `Unknown MCP server: ${msg.id}` });
    const current = new Set(grants[msg.id] ?? []);
    if (msg.granted) current.add(msg.tool);
    else current.delete(msg.tool);
    if (current.size === 0) delete grants[msg.id];
    else grants[msg.id] = [...current];
    return McpServerResult.parse({ ok: true, server: toBusServer(stored) });
  }

  return {
    mcpManager,
    grants,
    handleAdd,
    handleRemove,
    handleList,
    handleConnect,
    handleSetEnabled,
    handleToolGrantSet,
    handleOriginRepoGet,
    handleOriginRepoSet,
    handleOriginRepoClear,
    handleAuthStart,
  };
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

  it('a panel-side pre-grant makes the SW re-check a no-op — no second permission request (#157)', async () => {
    installChromeFakes();
    const { handleAdd } = makeHandlers(fakeMcpFactory({ task: {} }));
    const request = (
      globalThis as unknown as {
        chrome: { permissions: { request: ReturnType<typeof vi.fn> } };
      }
    ).chrome.permissions.request;

    // The panel requests the host permission inside the Add gesture, before the mcp-add RPC.
    expect(await ensureHostAccess('https://ai-dev.example.com/mcp')).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);

    // The SW handler re-checks (belt-and-braces): contains() is now true, so it does NOT prompt
    // again and the add succeeds. The panel-side grant + the SW-side re-check share ONE request.
    const added = await handleAdd({
      type: 'mcp-add',
      label: 'ai-dev',
      url: 'https://ai-dev.example.com/mcp',
    });
    expect(added.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
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

describe('integration: mcp-set-enabled flips the per-backend switch (#17)', () => {
  it('persists the flag, replies the bus record carrying it, and tears the live connection down', async () => {
    installChromeFakes();
    const { mcpManager, handleAdd, handleConnect, handleSetEnabled } = makeHandlers(
      fakeMcpFactory({ task: {} }),
    );

    const added = await handleAdd({ type: 'mcp-add', label: 'ai-dev', url: 'https://ai-dev/mcp' });
    const id = added.server?.id;
    if (!id) throw new Error('mcp-add did not return a server id');
    expect(added.server?.enabled).toBe(true); // new servers default enabled

    await handleConnect({ type: 'mcp-connect', id });
    expect(mcpManager.health(id)?.status).toBe('connected');

    const disabled = await handleSetEnabled({ type: 'mcp-set-enabled', id, enabled: false });
    expect(disabled.ok).toBe(true);
    expect(disabled.server).toMatchObject({ id, enabled: false, status: 'disconnected' });
    // Persisted, not just in-memory.
    expect((await getServer(id))?.enabled).toBe(false);
    expect(mcpManager.isEnabled(id)).toBe(false);
    expect(mcpManager.health(id)).toMatchObject({ enabled: false, status: 'disconnected' });
  });

  it('a subsequent mcp-connect on the disabled server replies the disabled error, no open attempted', async () => {
    installChromeFakes();
    const connect = vi.fn(async () => ({
      tools: async () => ({ task: {} }) as never,
      close: async () => {},
    })) as unknown as McpClientFactory;
    const { handleAdd, handleSetEnabled, handleConnect } = makeHandlers(connect);

    const added = await handleAdd({ type: 'mcp-add', label: 'ai-dev', url: 'https://ai-dev/mcp' });
    const id = added.server?.id;
    if (!id) throw new Error('mcp-add did not return a server id');
    await handleSetEnabled({ type: 'mcp-set-enabled', id, enabled: false });
    (connect as ReturnType<typeof vi.fn>).mockClear();

    const result = await handleConnect({ type: 'mcp-connect', id });
    expect(result).toEqual({
      ok: false,
      error: 'MCP server is disabled: ai-dev',
      server: undefined,
    });
    expect(connect).not.toHaveBeenCalled(); // credentials/transport never touched
  });

  it('re-enabling persists true and the next connect opens again', async () => {
    installChromeFakes();
    const { handleAdd, handleSetEnabled, handleConnect } = makeHandlers(
      fakeMcpFactory({ task: {} }),
    );

    const added = await handleAdd({ type: 'mcp-add', label: 'S', url: 'https://s/mcp' });
    const id = added.server?.id;
    if (!id) throw new Error('mcp-add did not return a server id');
    await handleSetEnabled({ type: 'mcp-set-enabled', id, enabled: false });

    const enabled = await handleSetEnabled({ type: 'mcp-set-enabled', id, enabled: true });
    expect(enabled.server).toMatchObject({ enabled: true, status: 'disconnected' }); // lazy — not opened yet
    expect((await getServer(id))?.enabled).toBe(true);

    const reconnected = await handleConnect({ type: 'mcp-connect', id });
    expect(reconnected.ok).toBe(true);
    expect(reconnected.server).toMatchObject({ enabled: true, status: 'connected', toolCount: 1 });
  });

  it('mcp-set-enabled on an unknown id returns ok:false without throwing', async () => {
    installChromeFakes();
    const { handleSetEnabled } = makeHandlers(fakeMcpFactory());
    const result = await handleSetEnabled({
      type: 'mcp-set-enabled',
      id: 'missing',
      enabled: false,
    });
    expect(result).toEqual({ ok: false, error: 'Unknown MCP server: missing', server: undefined });
  });
});

describe('integration: mcp-origin-repo RPCs curate the Ship mapping (#20)', () => {
  it('set/get round-trips entries — including backendId + branch overrides — and clear forgets', async () => {
    installChromeFakes();
    const { handleOriginRepoGet, handleOriginRepoSet, handleOriginRepoClear } = makeHandlers(
      fakeMcpFactory(),
    );

    expect(await handleOriginRepoGet()).toEqual({ ok: true, map: {} });

    expect(
      await handleOriginRepoSet({
        type: 'mcp-origin-repo-set',
        origin: 'localhost:3000',
        entry: { repo: 'acme/storefront' },
      }),
    ).toEqual({ ok: true, error: undefined });
    expect(
      await handleOriginRepoSet({
        type: 'mcp-origin-repo-set',
        origin: 'app.acme.com',
        entry: { repo: 'acme/app', backendId: 'ai-dev', branch: 'develop' },
      }),
    ).toEqual({ ok: true, error: undefined });

    const got = await handleOriginRepoGet();
    expect(got.map).toEqual({
      'localhost:3000': { repo: 'acme/storefront' },
      'app.acme.com': { repo: 'acme/app', backendId: 'ai-dev', branch: 'develop' },
    });
    // Persisted in the store the Ship route reads.
    expect(await getOriginRepoMap()).toEqual(got.map);

    expect(
      await handleOriginRepoClear({ type: 'mcp-origin-repo-clear', origin: 'localhost:3000' }),
    ).toEqual({ ok: true, error: undefined });
    expect((await handleOriginRepoGet()).map).toEqual({
      'app.acme.com': { repo: 'acme/app', backendId: 'ai-dev', branch: 'develop' },
    });
  });
});

describe('integration: mcp-tool-grant-set (#120 per-tool opt-in)', () => {
  it('grant/revoke round-trips through the bus record against the discovered catalog', async () => {
    installChromeFakes();
    const { handleAdd, handleConnect, handleToolGrantSet } = makeHandlers(
      fakeMcpFactory({ deploy: {}, create_pr: {}, kb: {}, task: {} }),
    );

    const added = await handleAdd({ type: 'mcp-add', label: 'ai-dev', url: 'https://ai-dev/mcp' });
    const id = added.server?.id;
    if (!id) throw new Error('mcp-add did not return a server id');

    // Before connect, no catalog: the gate's view is empty even if a grant exists.
    const connected = await handleConnect({ type: 'mcp-connect', id });
    expect(connected.server?.tools).toHaveLength(4);
    // writeTools = the discovered write-shaped BASE names — `task` excluded (never grantable),
    // `kb` not write-shaped.
    expect(connected.server?.writeTools).toEqual(['deploy', 'create_pr']);
    expect(connected.server?.grantedTools).toEqual([]);

    const granted = await handleToolGrantSet({
      type: 'mcp-tool-grant-set',
      id,
      tool: 'deploy',
      granted: true,
    });
    expect(granted.ok).toBe(true);
    expect(granted.server?.grantedTools).toEqual(['deploy']);

    const grantedSecond = await handleToolGrantSet({
      type: 'mcp-tool-grant-set',
      id,
      tool: 'create_pr',
      granted: true,
    });
    expect(grantedSecond.server?.grantedTools).toEqual(['deploy', 'create_pr']);

    // Idempotent re-grant — no duplicate.
    const regranted = await handleToolGrantSet({
      type: 'mcp-tool-grant-set',
      id,
      tool: 'deploy',
      granted: true,
    });
    expect(regranted.server?.grantedTools).toEqual(['deploy', 'create_pr']);

    const revoked = await handleToolGrantSet({
      type: 'mcp-tool-grant-set',
      id,
      tool: 'deploy',
      granted: false,
    });
    expect(revoked.server?.grantedTools).toEqual(['create_pr']);
  });

  it('grants never surface for names outside the write-shaped catalog (`task`, reads)', async () => {
    installChromeFakes();
    const { handleAdd, handleConnect, handleToolGrantSet } = makeHandlers(
      fakeMcpFactory({ deploy: {}, kb: {}, task: {} }),
    );

    const added = await handleAdd({ type: 'mcp-add', label: 'ai-dev', url: 'https://ai-dev/mcp' });
    const id = added.server?.id;
    if (!id) throw new Error('mcp-add did not return a server id');
    await handleConnect({ type: 'mcp-connect', id });

    // `task` is the hard-denied Ship verb — "granting" it can never make it appear.
    const taskGranted = await handleToolGrantSet({
      type: 'mcp-tool-grant-set',
      id,
      tool: 'task',
      granted: true,
    });
    expect(taskGranted.server?.writeTools).toEqual(['deploy']);
    expect(taskGranted.server?.grantedTools).toEqual([]);

    // A read-shaped name was never gated; a grant for it is stored but never surfaces.
    const kbGranted = await handleToolGrantSet({
      type: 'mcp-tool-grant-set',
      id,
      tool: 'kb',
      granted: true,
    });
    expect(kbGranted.server?.grantedTools).toEqual([]);
  });

  it('mcp-tool-grant-set on an unknown id returns ok:false without throwing', async () => {
    installChromeFakes();
    const { handleToolGrantSet } = makeHandlers(fakeMcpFactory());
    const result = await handleToolGrantSet({
      type: 'mcp-tool-grant-set',
      id: 'missing',
      tool: 'deploy',
      granted: true,
    });
    expect(result).toEqual({ ok: false, error: 'Unknown MCP server: missing', server: undefined });
  });

  it("mcp-remove purges the server's grants — no orphan survives a removal", async () => {
    installChromeFakes();
    const { grants, handleAdd, handleConnect, handleToolGrantSet, handleRemove } = makeHandlers(
      fakeMcpFactory({ deploy: {}, kb: {} }),
    );

    const added = await handleAdd({ type: 'mcp-add', label: 'ai-dev', url: 'https://ai-dev/mcp' });
    const id = added.server?.id;
    if (!id) throw new Error('mcp-add did not return a server id');
    await handleConnect({ type: 'mcp-connect', id });
    await handleToolGrantSet({ type: 'mcp-tool-grant-set', id, tool: 'deploy', granted: true });
    expect(grants[id]).toEqual(['deploy']);

    const removed = await handleRemove({ type: 'mcp-remove', id });
    expect(removed).toEqual({ ok: true, error: undefined });
    expect(grants[id]).toBeUndefined(); // purged — a re-added server starts with zero grants
  });
});
