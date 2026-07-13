import { afterEach, describe, expect, it, vi } from 'vitest';
import { reduceServers } from '@/entrypoints/sidepanel/stores/mcp';
import type { McpServer, PanelToSw } from '@/shared/messages';

// Pure fold: mirrors test/unit/focus.test.ts's reduceFocus coverage — no chrome, no
// Solid mount required.

const serverA: McpServer = {
  id: 'a',
  label: 'A',
  url: 'https://a.example.com/mcp',
  transport: 'http',
  authKind: 'none',
  status: 'disconnected',
  toolCount: 0,
  tools: [],
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
