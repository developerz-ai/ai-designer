// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearProviderConfig,
  getProviderConfig,
  hasProviderKey,
  saveProviderConfig,
} from '@/agent/config-store';
import { getOpenRouterKey, setOpenRouterKey } from '@/agent/key-store';
import { listModels, validateProvider } from '@/agent/provider';
import type { PanelToSw } from '@/shared/messages';
import { KeyStatusResult, ModelsResult, OkResult, SaveKeyResult } from '@/shared/messages';

// Integration — the BYOK key-custody RPCs (save-openrouter-key / key-status / clear-openrouter-key /
// list-models / set-model) end to end through the REAL cooperating SW modules (agent/key-store +
// agent/config-store + agent/provider) the way background.ts wires them: real WebCrypto (node env)
// encrypts the key under a real (fake) IndexedDB wrapping key, the ciphertext lands in fake
// chrome.storage.local, and the `/models` probe's `fetch` is stubbed (no network) — mirroring
// mcp-rpcs.test.ts. The key value NEVER crosses the bus (every reply is a presence/validity flag).
//
// background.ts imports the WXT `#imports` virtual module and can't be imported under Vitest, so its
// key/settings `handle()` cases are reproduced 1:1. REAL vs faked: real = key-store encrypt/decrypt +
// IndexedDB wrapping key, config-store persistence, provider validate/list, all result schemas.
// Faked = chrome.storage.local (Map-backed), IndexedDB (fake-indexeddb), and `fetch`.

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function installChromeFakes(): Map<string, unknown> {
  const storage = new Map<string, unknown>();
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
  (globalThis as { chrome?: unknown }).chrome = { storage: { local } };
  return storage;
}

// A stubbed openai-compatible `/models` endpoint: 200 with a two-model catalog.
function stubModelsFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'openrouter/auto', name: 'Auto' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
        ],
      }),
    })),
  );
}

// Reproduces background.ts's key/settings `handle()` cases 1:1 (the legacy OpenRouter-only RPCs +
// list-models). No SW-lifetime state to close over — these read/write the persisted stores directly.
const handlers = {
  // `case 'save-openrouter-key'`
  async saveKey(msg: PanelToSw & { type: 'save-openrouter-key' }) {
    const { ok: valid, error } = await validateProvider({
      baseURL: OPENROUTER_BASE_URL,
      apiKey: msg.text,
    });
    if (valid) await setOpenRouterKey(msg.text);
    return SaveKeyResult.parse({ ok: true, valid, error });
  },
  // `case 'set-model'`
  async setModel(msg: PanelToSw & { type: 'set-model' }) {
    const cfg = await getProviderConfig();
    await saveProviderConfig({
      baseURL: cfg?.baseURL ?? OPENROUTER_BASE_URL,
      label: cfg?.label,
      model: msg.model,
    });
    return OkResult.parse({ ok: true });
  },
  // `case 'key-status'`
  async keyStatus() {
    const cfg = await getProviderConfig();
    return KeyStatusResult.parse({ ok: true, present: await hasProviderKey(), model: cfg?.model });
  },
  // `case 'clear-openrouter-key'`
  async clearKey() {
    await clearProviderConfig();
    return OkResult.parse({ ok: true });
  },
  // `case 'list-models'`
  async listModels(msg: PanelToSw & { type: 'list-models' }) {
    const endpoint = msg.baseURL
      ? { baseURL: msg.baseURL, apiKey: msg.apiKey }
      : ((await getProviderConfig()) ?? {
          baseURL: OPENROUTER_BASE_URL,
          apiKey: (await getOpenRouterKey()) ?? undefined,
        });
    const models = await listModels(endpoint);
    return ModelsResult.parse({ ok: true, models });
  },
};

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  installChromeFakes();
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.unstubAllGlobals();
});

describe('integration: save-openrouter-key -> key-status -> set-model -> clear lifecycle', () => {
  it('encrypts + persists the key on a valid save, then reports presence without the value', async () => {
    stubModelsFetch();

    // Before any save: no key stored.
    expect(await handlers.keyStatus()).toEqual({ ok: true, present: false, model: undefined });

    const saved = await handlers.saveKey({ type: 'save-openrouter-key', text: 'sk-abc-123' });
    expect(saved).toEqual({ ok: true, valid: true, error: undefined });

    // The key is now present (encrypted via real WebCrypto), but no model/config yet.
    const afterSave = await handlers.keyStatus();
    expect(afterSave).toEqual({ ok: true, present: true, model: undefined });
    // It really round-trips through decrypt — the raw value is recoverable SW-side only.
    expect(await getOpenRouterKey()).toBe('sk-abc-123');

    // Choosing a model seeds the OpenRouter-preset config, preserving the stored key.
    await handlers.setModel({ type: 'set-model', model: 'anthropic/claude-3.5-sonnet' });
    const afterModel = await handlers.keyStatus();
    expect(afterModel).toEqual({
      ok: true,
      present: true,
      model: 'anthropic/claude-3.5-sonnet',
    });

    // Clear forgets both the config and the key.
    expect(await handlers.clearKey()).toEqual({ ok: true, error: undefined });
    expect(await handlers.keyStatus()).toEqual({ ok: true, present: false, model: undefined });
    expect(await getOpenRouterKey()).toBeNull();
  });

  it('does not persist the key when the endpoint rejects the probe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })),
    );

    const saved = await handlers.saveKey({ type: 'save-openrouter-key', text: 'sk-bad' });
    expect(saved.ok).toBe(true);
    expect(saved.valid).toBe(false);
    expect(saved.error).toBe('Provider /models responded 401');
    // Nothing persisted on an invalid save.
    expect(await hasProviderKey()).toBe(false);
    expect(await getOpenRouterKey()).toBeNull();
  });
});

describe('integration: list-models / set-model through the real provider + config store', () => {
  it('lists models for an explicit not-yet-saved endpoint (setup, pre-save)', async () => {
    stubModelsFetch();

    const result = await handlers.listModels({
      type: 'list-models',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-probe',
    });

    expect(result.ok).toBe(true);
    expect(result.models).toEqual([
      { id: 'openrouter/auto', name: 'Auto' },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
    ]);
  });

  it('falls back to the saved config + stored key when no endpoint is given', async () => {
    stubModelsFetch();
    await handlers.saveKey({ type: 'save-openrouter-key', text: 'sk-live' });
    await handlers.setModel({ type: 'set-model', model: 'openrouter/auto' });

    const result = await handlers.listModels({ type: 'list-models' });

    expect(result.ok).toBe(true);
    expect(result.models?.map((m) => m.id)).toContain('openrouter/auto');
    // The saved model is now the active config's model.
    expect((await getProviderConfig())?.model).toBe('openrouter/auto');
  });

  it('surfaces a non-2xx /models as an error from list-models', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    await expect(
      handlers.listModels({ type: 'list-models', baseURL: 'https://x/v1' }),
    ).rejects.toThrow('Provider /models responded 500');
  });
});
