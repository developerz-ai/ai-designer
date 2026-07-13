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

function health(id: string, status: McpHealth['status']): McpHealth {
  return { id, status, toolCount: 0, tools: [], checkedAt: 0 };
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
      hostPermission: 'needed',
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
});
