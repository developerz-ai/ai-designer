// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearProviderConfig,
  getProviderConfig,
  hasProviderConfig,
  hasProviderKey,
  migrateLegacyProvider,
  type ProviderConfig,
  saveProviderConfig,
} from '@/agent/config-store';
import { encryptSecret, getSecret, setOpenRouterKey } from '@/agent/key-store';

// config-store custody path end to end: real WebCrypto (node env) + a real (fake) IDB +
// an in-memory chrome.storage.local, so the plaintext/secret split is actually
// exercised, not mocked. jsdom lacks crypto.subtle, hence the env override.

// Minimal in-memory chrome.storage.local (MV3 promise API: get/set/remove).
function installChromeStorageLocalFake(): void {
  const store = new Map<string, unknown>();
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
  (globalThis as { chrome?: unknown }).chrome = { storage: { local } };
}

const CONFIG: ProviderConfig = {
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-v1-secret-value-123',
  model: 'anthropic/claude-3.5-sonnet',
  label: 'OpenRouter',
};

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // fresh empty IDB per test
  installChromeStorageLocalFake();
});

describe('config-store', () => {
  it('round-trips a config; the apiKey is stored encrypted, never plaintext', async () => {
    await saveProviderConfig(CONFIG);
    expect(await getProviderConfig()).toEqual(CONFIG);

    // The plaintext record holds the non-secret fields only — the key is not among them.
    const all = await chrome.storage.local.get(null);
    expect(all['provider:config']).toMatchObject({ baseURL: CONFIG.baseURL, model: CONFIG.model });
    // The key never lands in storage.local in the clear (its ciphertext lives under the
    // key-store's `secret:` namespace).
    expect(JSON.stringify(all)).not.toContain(CONFIG.apiKey);
    expect(Object.keys(all)).toContain('secret:provider:default:key');
  });

  it('reads null / false when nothing is stored', async () => {
    expect(await getProviderConfig()).toBeNull();
    expect(await hasProviderConfig()).toBe(false);
    expect(await hasProviderKey()).toBe(false);
  });

  it('keeps the existing key when a re-save omits apiKey (presence-only placeholder)', async () => {
    await saveProviderConfig(CONFIG);
    await saveProviderConfig({ baseURL: CONFIG.baseURL, model: 'openai/gpt-4o' });
    const got = await getProviderConfig();
    expect(got?.model).toBe('openai/gpt-4o');
    expect(got?.apiKey).toBe(CONFIG.apiKey); // key survived the model-only re-save
  });

  it('supports a keyless endpoint (no apiKey persisted)', async () => {
    await saveProviderConfig({ baseURL: 'http://localhost:1234/v1', model: 'local-model' });
    expect(await hasProviderKey()).toBe(false);
    expect(await getProviderConfig()).toEqual({
      baseURL: 'http://localhost:1234/v1',
      model: 'local-model',
    });
  });

  it('clears both the config and its stored key', async () => {
    await saveProviderConfig(CONFIG);
    await clearProviderConfig();
    expect(await getProviderConfig()).toBeNull();
    expect(await hasProviderConfig()).toBe(false);
    expect(await hasProviderKey()).toBe(false);
  });

  it('treats a corrupt stored record as unset', async () => {
    await chrome.storage.local.set({ 'provider:config': { baseURL: 'not-a-url' } });
    expect(await getProviderConfig()).toBeNull();
    expect(await hasProviderConfig()).toBe(false);
  });

  it('reads a key saved through the legacy OpenRouter shim (same default slot)', async () => {
    await setOpenRouterKey('sk-or-v1-legacy-key');
    await saveProviderConfig({ baseURL: CONFIG.baseURL, model: CONFIG.model }); // no apiKey re-entry
    expect((await getProviderConfig())?.apiKey).toBe('sk-or-v1-legacy-key');
  });
});

// A pre-ProviderConfig install stored the OpenRouter key as a bare payload under
// `openrouter-key` (no `secret:` namespace) and the model under `selected-model`. The
// wrapping key is unchanged, so `encryptSecret` here produces a decryptable legacy payload.
describe('config-store: migrateLegacyProvider', () => {
  it('ports a legacy key + selected model into the named-secret config', async () => {
    await chrome.storage.local.set({
      'openrouter-key': await encryptSecret('sk-or-v1-legacy'),
      'selected-model': 'anthropic/claude-3.5-sonnet',
    });

    await migrateLegacyProvider();

    // Key moved to the shared slot; the legacy records are retired.
    expect(await getSecret('provider:default:key')).toBe('sk-or-v1-legacy');
    expect(await hasProviderKey()).toBe(true);
    const all = await chrome.storage.local.get(null);
    expect(Object.keys(all)).not.toContain('openrouter-key');
    expect(Object.keys(all)).not.toContain('selected-model');

    // Config seeded from the OpenRouter preset + legacy model; the key reads back through it.
    expect(await getProviderConfig()).toEqual({
      baseURL: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3.5-sonnet',
      label: 'OpenRouter',
      apiKey: 'sk-or-v1-legacy',
    });
  });

  it('ports the key but writes no config when no model was ever selected', async () => {
    await chrome.storage.local.set({ 'openrouter-key': await encryptSecret('sk-only') });

    await migrateLegacyProvider();

    expect(await getSecret('provider:default:key')).toBe('sk-only');
    expect(await hasProviderConfig()).toBe(false);
    expect(await getProviderConfig()).toBeNull(); // key present, config completed on model pick
  });

  it('is a no-op on a fresh install and idempotent after a migration', async () => {
    await migrateLegacyProvider(); // nothing legacy -> no key, no config
    expect(await hasProviderKey()).toBe(false);
    expect(await getProviderConfig()).toBeNull();

    await chrome.storage.local.set({
      'openrouter-key': await encryptSecret('sk-once'),
      'selected-model': 'm/1',
    });
    await migrateLegacyProvider();
    await migrateLegacyProvider(); // legacy record already gone -> second call changes nothing
    expect(await getSecret('provider:default:key')).toBe('sk-once');
    expect((await getProviderConfig())?.model).toBe('m/1');
  });

  it('never clobbers a key already stored under the new scheme', async () => {
    await saveProviderConfig({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-new',
      model: 'gpt-4o',
    });
    await chrome.storage.local.set({ 'openrouter-key': await encryptSecret('sk-legacy') });

    await migrateLegacyProvider();

    // Existing config + key win; the legacy payload is discarded, not merged.
    expect((await getProviderConfig())?.apiKey).toBe('sk-new');
    const all = await chrome.storage.local.get(null);
    expect(Object.keys(all)).not.toContain('openrouter-key');
  });
});
