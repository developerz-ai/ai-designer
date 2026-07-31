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

  it('salvages good sessions alongside a corrupt one — never total amnesia (#168 audit)', async () => {
    const seeded = new SessionStore({ now: at(5) });
    await seeded.ensure(1, URL, SESSION_ID);
    await seeded.ensure(2, URL, SESSION_ID);
    backing.set('session:3', { tabId: 3, url: 42 /* corrupt */ });

    const revived = new SessionStore();
    await revived.hydrate();

    expect(revived.get(1)).toBeDefined();
    expect(revived.get(2)).toBeDefined();
    expect(revived.get(3)).toBeUndefined();
    expect(backing.has('session:1')).toBe(true);
    expect(backing.has('session:2')).toBe(true);
    expect(backing.has('session:3')).toBe(false); // only the corrupt record is purged
  });

  it('parses a pre-#168 record without lastMode (additive schema change)', async () => {
    const seeded = new SessionStore({ now: at(5) });
    await seeded.ensure(6, URL, SESSION_ID);
    const raw = backing.get('session:6') as Record<string, unknown>;
    delete raw.lastMode; // simulate a record written before the field existed

    const revived = new SessionStore();
    await revived.hydrate();
    expect(revived.get(6)).toBeDefined();
    expect(revived.get(6)?.lastMode).toBeUndefined();
  });
});

describe('SessionStore.lastMode (#168 mode stickiness)', () => {
  it('persists the session’s last resolved mode and round-trips it through hydrate', async () => {
    const store = new SessionStore({ now: at(1) });
    await store.ensure(7, URL, SESSION_ID);
    await store.patch(7, { lastMode: 'debug' });

    const revived = new SessionStore();
    await revived.hydrate();
    expect(revived.get(7)?.lastMode).toBe('debug');
  });
});

describe('SessionStore.appendMessages: high-water thread compaction (#168)', () => {
  it('stays append-only below the high-water mark', async () => {
    const store = new SessionStore({ now: at(1) });
    await store.ensure(9, URL, SESSION_ID);
    const updated = await store.appendMessages(
      9,
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    );
    expect(updated.messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ]);
  });

  it('digests the oldest turns once the thread crosses the high-water mark, keeping the newest verbatim', async () => {
    const store = new SessionStore({ now: at(1) });
    await store.ensure(10, URL, SESSION_ID);

    // ~40 turns of ~3.2k chars each ≈ 128k chars > the ~96k-char high-water mark.
    const payload = 'y'.repeat(3_000);
    for (let i = 0; i < 40; i++) {
      await store.appendMessages(
        10,
        { role: 'user', content: `ask ${i}` },
        { role: 'assistant', content: `${payload} (turn ${i})` },
      );
    }

    const session = store.get(10);
    if (!session) throw new Error('no session');
    expect(session.messages.length).toBeLessThan(80);
    const [first] = session.messages;
    if (first?.role !== 'user' || typeof first.content !== 'string') throw new Error('shape');
    expect(first.content).toContain('[Session memory]');
    // The newest turn always survives verbatim.
    expect(session.messages.at(-1)).toEqual({
      role: 'assistant',
      content: `${payload} (turn 39)`,
    });
    // And the persisted mirror matches the cache.
    expect(backing.get('session:10')).toMatchObject({
      messages: session.messages,
    });
  });
});
