// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { saveProviderConfig } from '@/agent/config-store';
import { computeReadiness, type McpHealthSource } from '@/agent/readiness';
import type { McpHealth } from '@/mcp/manager';

// readiness.ts truth table: provider missing / model missing / no host perm / mcp
// 0-of-N -> the correct per-check flags and `ready`. Mirrors config-store.test.ts's fake
// chrome.storage.local (real WebCrypto, node env, fake IDB for the key-store) plus a
// minimal chrome.permissions.contains fake; `McpManager` is stubbed via `McpHealthSource`
// (structural — just `allHealth()`) so this stays a pure unit test with no live connections.

function installChromeFakes(opts: { grantedOrigins?: string[] } = {}): void {
  const store = new Map<string, unknown>();
  const granted = new Set(opts.grantedOrigins ?? []);
  const local = {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const names = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (store.has(name)) out[name] = store.get(name);
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [name, value] of Object.entries(items)) store.set(name, value);
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      return Promise.resolve();
    },
  };
  const permissions = {
    contains: (p: { origins?: string[] }) =>
      Promise.resolve((p.origins ?? []).every((o) => granted.has(o))),
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { local }, permissions };
}

function mcpSource(health: McpHealth[]): McpHealthSource {
  return { allHealth: () => health };
}

function health(id: string, status: McpHealth['status'], enabled = true): McpHealth {
  return { id, status, toolCount: 0, tools: [], enabled, checkedAt: 0 };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // fresh empty IDB per test
});

describe('computeReadiness', () => {
  it('is not ready with nothing configured: provider/model missing, host permission needed', async () => {
    installChromeFakes();
    const state = await computeReadiness(mcpSource([]));
    expect(state).toEqual({
      provider: 'missing',
      model: 'missing',
      apiKey: 'missing',
      hostPermission: 'needed',
      pageAccess: 'needed',
      mcp: { connected: 0, total: 0 },
      ready: false,
    });
  });

  it('flags model missing when only the key/baseURL are configured', async () => {
    installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*'] });
    await chrome.storage.local.set({
      'provider:config': { baseURL: 'https://openrouter.ai/api/v1' },
    });
    // No model persisted -> saveProviderConfig would reject it (min(1)); write the
    // plaintext record directly to exercise the model-missing branch in isolation.
    const state = await computeReadiness(mcpSource([]));
    expect(state.provider).toBe('missing'); // no key stored either
    expect(state.model).toBe('missing');
    expect(state.hostPermission).toBe('needed'); // config-store read failed schema -> no cfg
    expect(state.ready).toBe(false);
  });

  it('is ready with a keyless-but-configured LOCAL provider (llama.cpp): apiKey not-required', async () => {
    // A keyless local openai-compatible endpoint is a SUPPORTED setup — the apiKey row reads
    // `not-required` rather than `missing`, so it never blocks Start for llama.cpp & friends.
    installChromeFakes({ grantedOrigins: ['http://localhost/*'] });
    await saveProviderConfig({
      baseURL: 'http://localhost:8080/v1',
      model: 'local-model',
      // no apiKey
    });
    const state = await computeReadiness(mcpSource([]));
    expect(state.provider).toBe('ok');
    expect(state.model).toBe('ok');
    expect(state.apiKey).toBe('not-required');
    expect(state.ready).toBe(true);
  });

  it('blocks Start on a keyless HOSTED provider — the setup that used to 401 mid-turn', async () => {
    // The regression this row exists for: baseURL + model saved, no key. Every check was green,
    // Start was enabled, and the first model call came back "Missing Authentication header".
    installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*'] });
    await saveProviderConfig({
      baseURL: 'https://openrouter.ai/api/v1',
      model: 'minimax/hailuo-3',
      // no apiKey
    });
    const state = await computeReadiness(mcpSource([]));
    expect(state.provider).toBe('ok');
    expect(state.model).toBe('ok');
    expect(state.apiKey).toBe('missing');
    expect(state.ready).toBe(false);
  });

  it('reports page access separately from the provider host grant, and never gates `ready`', async () => {
    // `<all_urls>` is what `chrome.tabs.captureVisibleTab` needs (screenshot / responsiveCapture /
    // inspectVisually). Without it the agent can still read and edit the DOM, so it must not block
    // Start — but it has to be VISIBLE, or vision silently fails mid-turn with Chrome's own
    // "Either the '<all_urls>' or 'activeTab' permission is required."
    installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*'] });
    await saveProviderConfig({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-secret',
      model: 'anthropic/claude-3.5-sonnet',
    });
    const without = await computeReadiness(mcpSource([]));
    expect(without.pageAccess).toBe('needed');
    expect(without.hostPermission).toBe('granted'); // the PROVIDER origin — a different grant
    expect(without.ready).toBe(true);

    installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*', '<all_urls>'] });
    await saveProviderConfig({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-secret',
      model: 'anthropic/claude-3.5-sonnet',
    });
    expect((await computeReadiness(mcpSource([]))).pageAccess).toBe('granted');
  });

  it('is ready once provider (key+baseURL) and model are both configured', async () => {
    installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*'] });
    await saveProviderConfig({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-secret',
      model: 'anthropic/claude-3.5-sonnet',
    });
    const state = await computeReadiness(mcpSource([]));
    expect(state.provider).toBe('ok');
    expect(state.model).toBe('ok');
    expect(state.hostPermission).toBe('granted');
    expect(state.ready).toBe(true); // MCP is optional: 0-of-0 still ready
  });

  it('reports host permission needed for a custom host without a runtime grant', async () => {
    installChromeFakes(); // nothing granted
    await saveProviderConfig({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-custom',
      model: 'gpt-4o',
    });
    const state = await computeReadiness(mcpSource([]));
    expect(state.hostPermission).toBe('needed');
    expect(state.ready).toBe(true); // hostPermission doesn't gate `ready`
  });

  it('counts connected vs total MCP servers without gating `ready`', async () => {
    installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*'] });
    await saveProviderConfig({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-secret',
      model: 'anthropic/claude-3.5-sonnet',
    });
    const state = await computeReadiness(
      mcpSource([health('a', 'connected'), health('b', 'error'), health('c', 'disconnected')]),
    );
    expect(state.mcp).toEqual({ connected: 1, total: 3 });
    expect(state.ready).toBe(true);
  });

  it('counts ENABLED servers only (#17): a disabled backend is neither reachable nor capacity', async () => {
    installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*'] });
    await saveProviderConfig({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-secret',
      model: 'anthropic/claude-3.5-sonnet',
    });
    // One enabled + connected, one disabled (stale 'connected' health from before the flip —
    // it must not count toward EITHER number).
    const state = await computeReadiness(
      mcpSource([health('a', 'connected'), health('b', 'connected', false)]),
    );
    expect(state.mcp).toEqual({ connected: 1, total: 1 });
    expect(state.ready).toBe(true);
  });

  it('reads total 0 when every server is disabled', async () => {
    installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*'] });
    await saveProviderConfig({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-secret',
      model: 'anthropic/claude-3.5-sonnet',
    });
    const state = await computeReadiness(
      mcpSource([health('a', 'connected', false), health('b', 'error', false)]),
    );
    expect(state.mcp).toEqual({ connected: 0, total: 0 });
    expect(state.ready).toBe(true); // MCP is optional — 0 enabled backends never gates Start
  });
});
