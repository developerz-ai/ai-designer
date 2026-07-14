import { beforeEach, describe, expect, it } from 'vitest';
import { type ChatMessage, SessionStore } from '@/agent/session';

// session.ts unit: the SW's design-session store persists to (and rehydrates from) an in-memory
// chrome.storage.session fake, exercising the eviction-resume round-trip without a real SW.

const URL = 'https://example.com/pricing';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

// Minimal in-memory chrome.storage.session (MV3 promise API), exposed for assertions. Values
// are round-tripped through JSON to mirror storage's serialization (no functions/Dates survive).
function installChromeStorageSessionFake(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  const session = {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const names = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (store.has(name)) out[name] = store.get(name);
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [name, value] of Object.entries(items))
        store.set(name, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      return Promise.resolve();
    },
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { session } };
  return store;
}

let backing: Map<string, unknown>;
const at = (ms: number) => () => ms;

beforeEach(() => {
  backing = installChromeStorageSessionFake();
});

describe('SessionStore.ensure', () => {
  it('creates + persists a session with an empty changeset keyed by tab', async () => {
    const store = new SessionStore({ now: at(1000) });
    const session = await store.ensure(7, URL, SESSION_ID);

    expect(session).toMatchObject({
      tabId: 7,
      url: URL,
      status: 'idle',
      usage: { steps: 0, tokens: 0 },
      messages: [],
      updatedAt: 1000,
    });
    expect(session.changeset).toEqual({
      url: URL,
      sessionId: SESSION_ID,
      createdAt: new Date(1000).toISOString(),
      edits: [],
    });
    expect(store.get(7)).toBe(session);
    expect(backing.has('session:7')).toBe(true);
  });

  it('is idempotent — a second ensure returns the cached session, not a new one', async () => {
    const store = new SessionStore();
    const first = await store.ensure(7, URL, SESSION_ID);
    const second = await store.ensure(
      7,
      'https://other.example/',
      'ffffffff-1111-4111-8111-111111111111',
    );
    expect(second).toBe(first);
    expect(second.url).toBe(URL); // the original wins
  });
});

describe('SessionStore mutations', () => {
  const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({ role, content });

  it('appends messages and persists the thread', async () => {
    const store = new SessionStore({ now: at(1) });
    await store.ensure(1, URL, SESSION_ID);
    await store.appendMessages(1, msg('user', 'make the CTA pop'));
    const updated = await store.appendMessages(1, msg('assistant', 'done'));

    expect(updated.messages).toEqual([
      { role: 'user', content: 'make the CTA pop' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(backing.get('session:1')).toMatchObject({ messages: updated.messages });
  });

  it('patches fields and bumps updatedAt from the injected clock', async () => {
    let t = 10;
    const store = new SessionStore({ now: () => t });
    await store.ensure(2, URL, SESSION_ID);
    t = 20;
    const patched = await store.patch(2, { status: 'running', usage: { steps: 4, tokens: 900 } });
    expect(patched).toMatchObject({
      status: 'running',
      usage: { steps: 4, tokens: 900 },
      updatedAt: 20,
    });
  });

  it('throws when mutating a tab with no session yet', async () => {
    const store = new SessionStore();
    await expect(store.appendMessages(99, msg('user', 'hi'))).rejects.toThrow(
      /No session for tab 99/,
    );
  });

  it('clears a session from cache and storage', async () => {
    const store = new SessionStore();
    await store.ensure(3, URL, SESSION_ID);
    await store.clear(3);
    expect(store.get(3)).toBeUndefined();
    expect(backing.has('session:3')).toBe(false);
    expect(store.size).toBe(0);
  });
});

describe('SessionStore.hydrate', () => {
  it('rehydrates persisted sessions into a fresh store (SW wake resume)', async () => {
    const first = new SessionStore({ now: at(5) });
    await first.ensure(4, URL, SESSION_ID);
    await first.appendMessages(4, { role: 'user', content: 'redesign the hero' });

    // A brand-new store (as if the SW was evicted and restarted) sees the persisted state.
    const revived = new SessionStore();
    expect(revived.get(4)).toBeUndefined();
    await revived.hydrate();

    const session = revived.get(4);
    expect(session?.messages).toEqual([{ role: 'user', content: 'redesign the hero' }]);
    expect(session?.changeset.sessionId).toBe(SESSION_ID);
    expect(revived.size).toBe(1);
  });

  it('drops a corrupt/legacy record instead of trusting it', async () => {
    backing.set('session:8', { tabId: 8, url: 42 /* not a string */ });
    const store = new SessionStore();
    await store.hydrate();
    expect(store.get(8)).toBeUndefined();
    expect(backing.has('session:8')).toBe(false); // purged
  });

  it('ignores non-session keys sharing the storage area', async () => {
    backing.set('some-other-key', { anything: true });
    const store = new SessionStore();
    await store.hydrate();
    expect(store.size).toBe(0);
    expect(backing.has('some-other-key')).toBe(true); // untouched
  });
});
