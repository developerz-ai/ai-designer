import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dropOriginRepo,
  isNoRepoReason,
  pageOriginOf,
  reduceServers,
  upsertOriginRepo,
} from '@/entrypoints/sidepanel/stores/mcp';
import type { McpServer, PanelToSw } from '@/shared/messages';

// Pure fold: mirrors test/unit/focus.test.ts's reduceFocus coverage — no chrome, no
// Solid mount required.

const serverA: McpServer = {
  id: 'a',
  label: 'A',
  url: 'https://a.example.com/mcp',
  transport: 'http',
  authKind: 'none',
  enabled: true,
  status: 'disconnected',
  toolCount: 0,
  tools: [],
  writeTools: [],
  grantedTools: [],
};

describe('reduceServers', () => {
  it('appends an unknown server on mcp-status', () => {
    expect(reduceServers([], { type: 'mcp-status', server: serverA })).toEqual([serverA]);
  });

  it('replaces an existing server by id', () => {
    const updated: McpServer = { ...serverA, status: 'connected', toolCount: 3, tools: ['x'] };
    expect(reduceServers([serverA], { type: 'mcp-status', server: updated })).toEqual([updated]);
  });

  it('ignores unrelated messages', () => {
    const tokenMsg = { type: 'token', text: 'hi' } as Parameters<typeof reduceServers>[1];
    expect(reduceServers([serverA], tokenMsg)).toEqual([serverA]);
  });

  it('is pure / does not mutate input', () => {
    const list = [serverA];
    reduceServers(list, { type: 'mcp-status', server: { ...serverA, status: 'connected' } });
    expect(list[0]?.status).toBe('disconnected');
  });
});

// RPC-level coverage: dispatch-only actions round-trip through chrome.runtime.sendMessage
// (fake, no real extension context), mirroring test/unit/settings-store.test.ts's pattern.
type SendMessage = (msg: PanelToSw) => unknown;

function installChromeFake(handle: SendMessage): { sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn(async (msg: unknown) => handle(msg as PanelToSw));
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
  return { sendMessage };
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('mcp store actions', () => {
  it('addServer dispatches mcp-add and applies the returned server', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'mcp-add') {
        return {
          ok: true,
          server: { ...serverA, id: 'b', label: msg.label, url: msg.url, authKind: 'apikey' },
        };
      }
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/mcp');

    const ok = await store.addServer({ label: 'B', url: 'https://b.example.com/mcp' });

    expect(ok).toBe(true);
    expect(store.servers.some((s) => s.id === 'b')).toBe(true);
  });

  it('addServer surfaces a failure without adding anything', async () => {
    vi.resetModules();
    installChromeFake(() => ({ ok: false, error: 'Host access denied' }));
    const store = await import('@/entrypoints/sidepanel/stores/mcp');

    const ok = await store.addServer({ label: 'B', url: 'https://b.example.com/mcp' });

    expect(ok).toBe(false);
    expect(store.servers).toHaveLength(0);
    expect(store.error()).toBe('Host access denied');
  });

  it('submitApiKey tracks pending state and clears it on completion', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'mcp-auth-start' && msg.authKind === 'apikey') {
        return { ok: true, server: { ...serverA, authKind: 'apikey', status: 'connected' } };
      }
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/mcp');

    const pendingDuring = store.submitApiKey('a', 'sk-test');
    const ok = await pendingDuring;

    expect(ok).toBe(true);
    expect(store.authPending()).toBeNull();
    expect(store.servers.find((s) => s.id === 'a')?.status).toBe('connected');
  });

  it('removeServer drops the server from local state on success', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'mcp-list') return { ok: true, servers: [serverA] };
      if (msg.type === 'mcp-remove') return { ok: true };
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/mcp');

    await store.hydrateMcp();
    expect(store.servers).toHaveLength(1);

    await store.removeServer('a');
    expect(store.servers).toHaveLength(0);
  });
});

// #17: the per-row enable/disable switch round-trips through mcp-set-enabled and folds the
// replied record back into the row.
describe('mcp store: setEnabled (#17)', () => {
  it('flips enabled off and back on from the replied server record', async () => {
    vi.resetModules();
    const seen: boolean[] = [];
    installChromeFake((msg) => {
      if (msg.type === 'mcp-list') return { ok: true, servers: [serverA] };
      if (msg.type === 'mcp-set-enabled') {
        seen.push(msg.enabled);
        return { ok: true, server: { ...serverA, enabled: msg.enabled } };
      }
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/mcp');

    await store.hydrateMcp();
    expect(store.servers.find((s) => s.id === 'a')?.enabled).toBe(true);

    await store.setEnabled('a', false);
    expect(store.servers.find((s) => s.id === 'a')?.enabled).toBe(false);

    await store.setEnabled('a', true);
    expect(store.servers.find((s) => s.id === 'a')?.enabled).toBe(true);
    expect(seen).toEqual([false, true]);
  });

  it('surfaces a failure and leaves the row as-is', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'mcp-list') return { ok: true, servers: [serverA] };
      if (msg.type === 'mcp-set-enabled') return { ok: false, error: 'Unknown MCP server: a' };
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/mcp');

    await store.hydrateMcp();
    await store.setEnabled('a', false);

    expect(store.servers.find((s) => s.id === 'a')?.enabled).toBe(true);
    expect(store.error()).toBe('Unknown MCP server: a');
  });
});

// #120: the per-tool grant toggle round-trips through mcp-tool-grant-set and folds the replied
// record's grantedTools back into the row (mirrors the setEnabled coverage above).
describe('mcp store: setToolGrant (#120)', () => {
  const connectedA: McpServer = {
    ...serverA,
    status: 'connected',
    toolCount: 2,
    tools: ['a__deploy', 'a__get_status'],
    writeTools: ['deploy'],
  };

  it('grants then revokes from the replied server record', async () => {
    vi.resetModules();
    const seen: Array<{ tool: string; granted: boolean }> = [];
    installChromeFake((msg) => {
      if (msg.type === 'mcp-list') return { ok: true, servers: [connectedA] };
      if (msg.type === 'mcp-tool-grant-set') {
        seen.push({ tool: msg.tool, granted: msg.granted });
        return { ok: true, server: { ...connectedA, grantedTools: msg.granted ? ['deploy'] : [] } };
      }
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/mcp');

    await store.hydrateMcp();
    expect(store.servers.find((s) => s.id === 'a')?.grantedTools).toEqual([]);

    await store.setToolGrant('a', 'deploy', true);
    expect(store.servers.find((s) => s.id === 'a')?.grantedTools).toEqual(['deploy']);

    await store.setToolGrant('a', 'deploy', false);
    expect(store.servers.find((s) => s.id === 'a')?.grantedTools).toEqual([]);
    expect(seen).toEqual([
      { tool: 'deploy', granted: true },
      { tool: 'deploy', granted: false },
    ]);
  });

  it('surfaces a failure and leaves the row as-is', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'mcp-list') return { ok: true, servers: [connectedA] };
      if (msg.type === 'mcp-tool-grant-set') return { ok: false, error: 'Unknown MCP server: a' };
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/mcp');

    await store.hydrateMcp();
    await store.setToolGrant('a', 'deploy', true);

    expect(store.servers.find((s) => s.id === 'a')?.grantedTools).toEqual([]);
    expect(store.error()).toBe('Unknown MCP server: a');
  });
});

// #20: origin→repo map — pure folds plus the load/save/remove RPC flows.
describe('origin-repo folds', () => {
  const entry = { repo: 'acme/storefront', backendId: 'b1', branch: 'main' };

  it('upsertOriginRepo adds or replaces an entry without mutating the input', () => {
    const map: Record<string, { repo: string }> = { 'a.example.com': { repo: 'acme/a' } };
    const next = upsertOriginRepo(map, 'b.example.com', entry);
    expect(next['b.example.com']).toEqual(entry);
    expect(upsertOriginRepo(next, 'b.example.com', { repo: 'acme/b' })['b.example.com']).toEqual({
      repo: 'acme/b',
    });
    expect(map['b.example.com']).toBeUndefined();
  });

  it('dropOriginRepo removes a key and is an identity no-op for a missing one', () => {
    const map = { 'a.example.com': { repo: 'acme/a' } };
    expect(dropOriginRepo(map, 'a.example.com')).toEqual({});
    expect(dropOriginRepo(map, 'missing.example.com')).toBe(map);
  });
});

describe('mcp store: origin→repo actions (#20)', () => {
  it('loadOriginRepos populates the map from mcp-origin-repo-get', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'mcp-origin-repo-get') {
        return { ok: true, map: { 'openrouter.ai': { repo: 'acme/storefront' } } };
      }
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/mcp');

    await store.loadOriginRepos();
    expect(store.originRepos()).toEqual({ 'openrouter.ai': { repo: 'acme/storefront' } });
  });

  it('saveOriginRepo dispatches mcp-origin-repo-set and folds the entry locally', async () => {
    vi.resetModules();
    let saved: { origin: string; entry: unknown } | null = null;
    installChromeFake((msg) => {
      if (msg.type === 'mcp-origin-repo-set') {
        saved = { origin: msg.origin, entry: msg.entry };
        return { ok: true };
      }
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/mcp');

    const entry = { repo: 'acme/storefront', branch: 'main' };
    const ok = await store.saveOriginRepo('openrouter.ai', entry);

    expect(ok).toBe(true);
    expect(saved).toEqual({ origin: 'openrouter.ai', entry });
    expect(store.originRepos()['openrouter.ai']).toEqual(entry);
  });

  it('saveOriginRepo reloads the map from the SW on failure', async () => {
    vi.resetModules();
    let gets = 0;
    installChromeFake((msg) => {
      if (msg.type === 'mcp-origin-repo-set') return { ok: false, error: 'storage full' };
      if (msg.type === 'mcp-origin-repo-get') {
        gets++;
        return { ok: true, map: {} };
      }
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/mcp');

    const ok = await store.saveOriginRepo('openrouter.ai', { repo: 'acme/storefront' });

    expect(ok).toBe(false);
    expect(store.error()).toBe('storage full');
    expect(gets).toBe(1); // re-synced from the SW, not trusting the local copy
    expect(store.originRepos()).toEqual({});
  });

  it('removeOriginRepo dispatches mcp-origin-repo-clear and drops the entry', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'mcp-origin-repo-get') {
        return { ok: true, map: { 'openrouter.ai': { repo: 'acme/storefront' } } };
      }
      if (msg.type === 'mcp-origin-repo-clear') return { ok: true };
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/mcp');

    await store.loadOriginRepos();
    expect(store.originRepos()).toHaveProperty('openrouter.ai');

    await store.removeOriginRepo('openrouter.ai');
    expect(store.originRepos()).toEqual({});
  });
});

// ShipBar's no-repo affordance keys off the rendered fallback sentence (the bus never carries
// the 'no-repo' enum), and the mapping form's origin derivation.
describe('isNoRepoReason / pageOriginOf', () => {
  it('matches only the no-repo fallback sentence', () => {
    // Verbatim src/mcp/backend.ts fallbackMessage output — the coupling this guard relies on.
    expect(isNoRepoReason('No repo is mapped for this page yet.')).toBe(true);
    expect(isNoRepoReason('No coding backend connected — download the brief.')).toBe(false);
    expect(isNoRepoReason(null)).toBe(false);
  });

  it('derives a lowercased host[:port] from http(s) URLs only', () => {
    expect(pageOriginOf('https://OpenRouter.ai/path?q=1')).toBe('openrouter.ai');
    expect(pageOriginOf('http://localhost:3000/app')).toBe('localhost:3000');
    expect(pageOriginOf('chrome-extension://abc123/sidepanel.html')).toBeNull();
    expect(pageOriginOf('chrome://extensions')).toBeNull();
    expect(pageOriginOf('about:blank')).toBeNull();
    expect(pageOriginOf(undefined)).toBeNull();
    expect(pageOriginOf('not a url')).toBeNull();
  });
});
