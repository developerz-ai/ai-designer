// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearOpenRouterKey,
  clearSecret,
  ensureWrappingKey,
  getOpenRouterKey,
  getSecret,
  hasOpenRouterKey,
  hasSecret,
  setOpenRouterKey,
  setSecret,
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

describe('key-store: named secrets', () => {
  it('round-trips a secret: generate -> store -> encrypt -> reload-from-IDB -> decrypt', async () => {
    const value = 'sk-or-v1-deadbeefcafe0123456789';
    await setSecret('provider:default:key', value);

    // Only ciphertext is persisted — the plaintext never lands in storage.local.
    const persisted = await chrome.storage.local.get('secret:provider:default:key');
    expect(JSON.stringify(persisted)).not.toContain(value);

    // Stateless module: this read reloads the wrapping key from IndexedDB + decrypts.
    expect(await getSecret('provider:default:key')).toBe(value);
    expect(await hasSecret('provider:default:key')).toBe(true);
  });

  it('isolates secrets by name; missing names read as null/false', async () => {
    await setSecret('provider:a:key', 'aaa');
    await setSecret('provider:b:key', 'bbb');
    expect(await getSecret('provider:a:key')).toBe('aaa');
    expect(await getSecret('provider:b:key')).toBe('bbb');
    expect(await getSecret('provider:missing:key')).toBeNull();
    expect(await hasSecret('provider:missing:key')).toBe(false);
  });

  it('namespaces storage keys under `secret:` (no collision with plaintext config)', async () => {
    await setSecret('provider:default:key', 'x');
    const all = await chrome.storage.local.get(null);
    expect(Object.keys(all)).toContain('secret:provider:default:key');
    expect(Object.keys(all)).not.toContain('provider:default:key');
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
    await setSecret('n', 'same-secret');
    const a = await chrome.storage.local.get('secret:n');
    await setSecret('n', 'same-secret');
    const b = await chrome.storage.local.get('secret:n');
    expect(a['secret:n']).not.toEqual(b['secret:n']);
  });

  it('clears a named secret', async () => {
    await setSecret('n', 'to-be-cleared');
    expect(await hasSecret('n')).toBe(true);
    await clearSecret('n');
    expect(await hasSecret('n')).toBe(false);
    expect(await getSecret('n')).toBeNull();
  });
});

describe('key-store: OpenRouter shims (default provider slot)', () => {
  it('delegate to the `provider:default:key` named secret', async () => {
    const key = 'sk-or-v1-deadbeefcafe0123456789';
    await setOpenRouterKey(key);

    // Shim writes through to the named secret; only ciphertext persisted.
    expect(await getSecret('provider:default:key')).toBe(key);
    const persisted = await chrome.storage.local.get('secret:provider:default:key');
    expect(JSON.stringify(persisted)).not.toContain(key);

    expect(await getOpenRouterKey()).toBe(key);
    expect(await hasOpenRouterKey()).toBe(true);
  });

  it('clears through the shim', async () => {
    await setOpenRouterKey('to-be-cleared');
    expect(await hasOpenRouterKey()).toBe(true);
    await clearOpenRouterKey();
    expect(await hasOpenRouterKey()).toBe(false);
    expect(await getOpenRouterKey()).toBeNull();
    expect(await hasSecret('provider:default:key')).toBe(false);
  });
});
