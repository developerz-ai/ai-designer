// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearOpenRouterKey,
  ensureWrappingKey,
  getOpenRouterKey,
  hasOpenRouterKey,
  setOpenRouterKey,
} from '@/agent/key-store';

// Real crypto (Node WebCrypto via the `node` env above) + a real (fake) IndexedDB,
// so this exercises the actual custody path, not a mock of it. jsdom has no
// crypto.subtle, hence the env override.

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
    remove(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { local } };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // fresh empty IDB per test
  installChromeStorageLocalFake();
});

describe('key-store', () => {
  it('round-trips a key: generate -> store -> encrypt -> reload-from-IDB -> decrypt', async () => {
    const secret = 'sk-or-v1-deadbeefcafe0123456789';
    await setOpenRouterKey(secret);

    // Only ciphertext is persisted — the plaintext never lands in storage.local.
    const persisted = await chrome.storage.local.get('openrouter-key');
    expect(JSON.stringify(persisted)).not.toContain(secret);

    // Stateless module: this read reloads the wrapping key from IndexedDB + decrypts.
    expect(await getOpenRouterKey()).toBe(secret);
    expect(await hasOpenRouterKey()).toBe(true);
  });

  it('persists a non-extractable wrapping key; exportKey("raw") REJECTS', async () => {
    const key = await ensureWrappingKey();
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();

    // ...and it survives the IndexedDB structured-clone round-trip still non-extractable.
    const reloaded = await ensureWrappingKey();
    expect(reloaded.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', reloaded)).rejects.toThrow();
  });

  it('uses a fresh IV per encrypt (no ciphertext reuse for the same plaintext)', async () => {
    await setOpenRouterKey('same-secret');
    const a = await chrome.storage.local.get('openrouter-key');
    await setOpenRouterKey('same-secret');
    const b = await chrome.storage.local.get('openrouter-key');
    expect(a['openrouter-key']).not.toEqual(b['openrouter-key']);
  });

  it('clears the stored key', async () => {
    await setOpenRouterKey('to-be-cleared');
    expect(await hasOpenRouterKey()).toBe(true);
    await clearOpenRouterKey();
    expect(await hasOpenRouterKey()).toBe(false);
    expect(await getOpenRouterKey()).toBeNull();
  });
});
