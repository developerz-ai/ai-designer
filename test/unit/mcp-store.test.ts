// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasSecret, setSecret } from '@/agent/key-store';
import { getAccessToken, mcpSecretNames, saveApiKey } from '@/mcp/auth';
import {
  clearOriginRepo,
  getOAuthConfigs,
  getOriginRepoMap,
  getServer,
  listServers,
  removeOAuthConfig,
  removeServer,
  saveOAuthConfig,
  saveServer,
  setOriginRepo,
} from '@/mcp/store';

// mcp/store persistence round-trip: a real (fake) IDB + in-memory chrome.storage.local so the
// plaintext record split and the secret-purge-on-remove are actually exercised (secrets go
// through the real key-store, which needs WebCrypto -> node env).

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

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  installChromeStorageLocalFake();
});

describe('mcp/store', () => {
  it('round-trips a server, defaulting transport + authKind from a minimal record', async () => {
    const saved = await saveServer({ id: 'ai-dev', label: 'ai-dev', url: 'https://ai-dev/mcp' });
    expect(saved).toEqual({
      id: 'ai-dev',
      label: 'ai-dev',
      url: 'https://ai-dev/mcp',
      transport: 'http',
      authKind: 'none',
    });
    expect(await getServer('ai-dev')).toEqual(saved);
    expect(await listServers()).toEqual([saved]);
  });

  it('persists only the non-secret record (no credential fields)', async () => {
    await saveServer({ id: 's', label: 'S', url: 'https://s/mcp', authKind: 'apikey' });
    const all = await chrome.storage.local.get(null);
    expect(all['mcp:servers']).toEqual([
      { id: 's', label: 'S', url: 'https://s/mcp', transport: 'http', authKind: 'apikey' },
    ]);
  });

  it('upserts by id (a re-save replaces, not duplicates)', async () => {
    await saveServer({ id: 's', label: 'Old', url: 'https://s/mcp' });
    await saveServer({ id: 's', label: 'New', url: 'https://s/mcp', authKind: 'oauth' });
    const list = await listServers();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: 'New', authKind: 'oauth' });
  });

  it('keeps multiple distinct servers', async () => {
    await saveServer({ id: 'a', label: 'A', url: 'https://a/mcp' });
    await saveServer({ id: 'b', label: 'B', url: 'https://b/mcp' });
    expect((await listServers()).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('removeServer drops the record and purges both stored credentials', async () => {
    await saveServer({ id: 's', label: 'S', url: 'https://s/mcp', authKind: 'apikey' });
    await saveApiKey('s', 'secret-key');
    expect(await hasSecret(mcpSecretNames('s').apiKey)).toBe(true);

    await removeServer('s');
    expect(await getServer('s')).toBeNull();
    expect(await hasSecret(mcpSecretNames('s').apiKey)).toBe(false);
    expect(await hasSecret(mcpSecretNames('s').token)).toBe(false);
  });

  it('drops corrupt entries on read rather than failing the whole list', async () => {
    await chrome.storage.local.set({
      'mcp:servers': [
        { id: 'ok', label: 'OK', url: 'https://ok/mcp', transport: 'http', authKind: 'none' },
        { id: '', label: 'bad-empty-id' },
        'not-an-object',
      ],
    });
    expect((await listServers()).map((s) => s.id)).toEqual(['ok']);
  });

  it('rejects an invalid url on save; unknown reads are null/no-op', async () => {
    await expect(saveServer({ id: 'x', label: 'X', url: 'not-a-url' })).rejects.toThrow();
    expect(await getServer('missing')).toBeNull();
    await expect(removeServer('missing')).resolves.toBeUndefined();
  });
});

describe('mcp/store origin→repo map', () => {
  it('round-trips an origin→repo mapping', async () => {
    expect(await getOriginRepoMap()).toEqual({});
    await setOriginRepo('localhost:3000', 'acme/storefront');
    expect(await getOriginRepoMap()).toEqual({ 'localhost:3000': 'acme/storefront' });
  });

  it('upserts by origin and clears a single mapping', async () => {
    await setOriginRepo('a', 'x/1');
    await setOriginRepo('b', 'y/2');
    await setOriginRepo('a', 'x/2'); // upsert, not duplicate
    expect(await getOriginRepoMap()).toEqual({ a: 'x/2', b: 'y/2' });

    await clearOriginRepo('a');
    expect(await getOriginRepoMap()).toEqual({ b: 'y/2' });
    await expect(clearOriginRepo('missing')).resolves.toBeUndefined();
  });

  it('drops corrupt/empty entries on read', async () => {
    await chrome.storage.local.set({
      'mcp:origin-repo': { good: 'o/r', bad: 42, '': 'x/y', blank: '' },
    });
    expect(await getOriginRepoMap()).toEqual({ good: 'o/r' });
  });
});

describe('mcp/store OAuth endpoint config (non-secret, rehydrated after SW eviction)', () => {
  const OAUTH = {
    authorizationEndpoint: 'https://auth.example.com/authorize',
    tokenEndpoint: 'https://auth.example.com/token',
    clientId: 'client-123',
    scope: 'mcp.read',
  };

  it('round-trips + upserts an endpoint config; removeOAuthConfig forgets it', async () => {
    expect(await getOAuthConfigs()).toEqual({});
    await saveOAuthConfig('srv', OAUTH);
    expect(await getOAuthConfigs()).toEqual({ srv: OAUTH });

    await saveOAuthConfig('srv', { ...OAUTH, clientId: 'client-456' }); // upsert
    expect((await getOAuthConfigs()).srv?.clientId).toBe('client-456');

    await removeOAuthConfig('srv');
    expect(await getOAuthConfigs()).toEqual({});
    await expect(removeOAuthConfig('missing')).resolves.toBeUndefined();
  });

  it('removeServer purges the persisted endpoint config alongside the record', async () => {
    await saveServer({ id: 's', label: 'S', url: 'https://s/mcp', authKind: 'oauth' });
    await saveOAuthConfig('s', OAUTH);
    await removeServer('s');
    expect(await getOAuthConfigs()).toEqual({});
  });

  it('a woken SW rehydrates the endpoint config so a stored token still refreshes (no forced re-auth)', async () => {
    // Simulate the restart-with-token path: the encrypted refresh token survives eviction, and the
    // NON-secret endpoint config is read back from storage — together they let `getAccessToken`
    // refresh an expired token instead of skipping refresh (which forced re-auth before B2).
    await saveOAuthConfig('srv', OAUTH);
    await setSecret(
      mcpSecretNames('srv').token,
      JSON.stringify({ accessToken: 'old', refreshToken: 'r1', expiresAt: 500 }),
    );

    const rehydrated = (await getOAuthConfigs()).srv; // what mcpReady puts back in `oauthConfigs`
    expect(rehydrated).toEqual(OAUTH);

    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh', expires_in: 3600 }),
      text: async () => '',
    }) as unknown as typeof globalThis.fetch;

    const token = await getAccessToken('srv', rehydrated, { fetch, now: () => 1_000_000 });
    expect(token).toBe('fresh'); // refreshed — the rehydrated config made it possible
  });

  it('reads a corrupt record back as an empty map', async () => {
    await chrome.storage.local.set({ 'mcp:oauth-configs': { srv: { clientId: 'x' } } }); // missing endpoints
    expect(await getOAuthConfigs()).toEqual({});
  });
});
