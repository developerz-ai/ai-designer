import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearToolGrants, getToolGrants, setToolGrant } from '@/mcp/tool-grants';

// mcp/tool-grants store (#120): the durable half of the per-tool opt-in. Round-trip
// grant/revoke against an in-memory chrome.storage.local (same fake as mcp-store.test.ts —
// tool-grants touches no IDB, so no node env / fake-indexeddb needed here). Proves the
// store's own invariants: last-revoke drops the server's key, corrupt entries are dropped
// on read, clearToolGrants purges a server and no-ops on an unknown one.

const KEY = 'mcp:tool-grants';

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

/** The raw persisted value under the grants key (undefined when never written). */
async function rawGrants(): Promise<unknown> {
  return (await chrome.storage.local.get(KEY))[KEY];
}

beforeEach(() => {
  installChromeStorageLocalFake();
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
});

describe('mcp/tool-grants (#120)', () => {
  it('round-trips grants per server, accumulating tools without duplicates', async () => {
    expect(await getToolGrants()).toEqual({});

    await setToolGrant('ai-dev', 'deploy', true);
    expect(await getToolGrants()).toEqual({ 'ai-dev': ['deploy'] });

    await setToolGrant('ai-dev', 'create_pr', true);
    await setToolGrant('ai-dev', 'deploy', true); // idempotent re-grant — no duplicate
    expect(await getToolGrants()).toEqual({ 'ai-dev': ['deploy', 'create_pr'] });

    await setToolGrant('github', 'publish', true); // a second server is independent
    expect(await getToolGrants()).toEqual({
      'ai-dev': ['deploy', 'create_pr'],
      github: ['publish'],
    });
  });

  it('persists the whole map under the one storage key', async () => {
    await setToolGrant('ai-dev', 'deploy', true);
    expect(await rawGrants()).toEqual({ 'ai-dev': ['deploy'] });
  });

  it('revoke removes the tool but keeps the server key while other grants remain', async () => {
    await setToolGrant('ai-dev', 'deploy', true);
    await setToolGrant('ai-dev', 'create_pr', true);

    await setToolGrant('ai-dev', 'deploy', false);
    expect(await getToolGrants()).toEqual({ 'ai-dev': ['create_pr'] });

    await setToolGrant('ai-dev', 'never-granted', false); // idempotent no-op revoke
    expect(await getToolGrants()).toEqual({ 'ai-dev': ['create_pr'] });
  });

  it('revoking the LAST grant drops the server key entirely', async () => {
    await setToolGrant('ai-dev', 'deploy', true);
    await setToolGrant('github', 'publish', true);

    await setToolGrant('ai-dev', 'deploy', false);
    expect(await getToolGrants()).toEqual({ github: ['publish'] });
    expect(await rawGrants()).toEqual({ github: ['publish'] }); // no empty-array tombstone
  });

  it('revoking on an unknown server is a no-op that persists nothing', async () => {
    await setToolGrant('missing', 'deploy', false);
    expect(await getToolGrants()).toEqual({});
    expect(await rawGrants()).toEqual({}); // written once, still keyless
  });

  it('drops corrupt entries on read rather than failing the whole map', async () => {
    await chrome.storage.local.set({
      [KEY]: {
        good: ['deploy', 'create_pr'],
        'not-an-array': 42,
        'string-entry': 'deploy',
        '': ['deploy'], // empty server id
        'non-string-members': ['ok', 1, null, undefined, {}],
        'all-bad-members': [1, null],
        'empty-array': [],
        'empty-strings': [''],
      },
    });
    expect(await getToolGrants()).toEqual({
      good: ['deploy', 'create_pr'],
      'non-string-members': ['ok'],
    });
  });

  it('reads a corrupt top-level value back as an empty map', async () => {
    for (const bad of [['deploy'], 'deploy', 42, null, true]) {
      await chrome.storage.local.set({ [KEY]: bad });
      expect(await getToolGrants(), JSON.stringify(bad)).toEqual({});
    }
  });

  it('clearToolGrants purges one server and leaves the rest', async () => {
    await setToolGrant('ai-dev', 'deploy', true);
    await setToolGrant('github', 'publish', true);

    await clearToolGrants('ai-dev');
    expect(await getToolGrants()).toEqual({ github: ['publish'] });

    await clearToolGrants('github');
    expect(await getToolGrants()).toEqual({});
  });

  it('clearToolGrants on an unknown server no-ops without writing', async () => {
    await expect(clearToolGrants('missing')).resolves.toBeUndefined();
    expect(await rawGrants()).toBeUndefined(); // never touched storage
  });
});
