import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore, TurnSession } from '@/agent/session';
import { LOG_CAP } from '@/agent/turn-log';

// `SessionStore`'s debug-log field. The two properties that matter are the ones a QA session
// depends on: an append must never be able to fail a turn, and the log must not grow without bound
// inside a `chrome.storage.session` record.

/** In-memory `chrome.storage.session` fake, round-tripping through JSON so stored values behave
 *  like real serialized ones (a Date or a Map would not survive, and neither would it in Chrome). */
function fakeSessionArea() {
  const backing = new Map<string, unknown>();
  return {
    backing,
    get: vi.fn((keys?: unknown) => {
      const names = keys == null ? [...backing.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names)
        if (backing.has(String(name))) out[String(name)] = backing.get(String(name));
      return Promise.resolve(out);
    }),
    set: vi.fn((items: Record<string, unknown>) => {
      for (const [name, value] of Object.entries(items)) {
        backing.set(name, JSON.parse(JSON.stringify(value)));
      }
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) backing.delete(k);
      return Promise.resolve();
    }),
  };
}

let area: ReturnType<typeof fakeSessionArea>;

beforeEach(() => {
  area = fakeSessionArea();
  vi.stubGlobal('chrome', { storage: { session: area } });
});

const entry = (n: number) => ({ at: n, kind: 'note' as const, text: `#${n}` });

/** `Changeset.sessionId` is `z.uuid()`, so a placeholder like `'s1'` makes the whole `TurnSession`
 *  fail to parse — and `hydrate()` DROPS a record that fails to parse, which reads as "the log was
 *  not persisted" rather than "the fixture was invalid". */
const SESSION_ID = '3f1a8c2e-9b4d-4c7a-8e21-5d6f0a7b9c10';

describe('SessionStore.appendLog', () => {
  it('appends to the tab session and persists it', async () => {
    const store = new SessionStore({ now: () => 1 });
    await store.ensure(7, 'https://example.com', SESSION_ID);

    await store.appendLog(7, entry(1));
    await store.appendLog(7, entry(2));

    expect(store.get(7)?.log.map((e) => e.text)).toEqual(['#1', '#2']);
    // Persisted, not just cached — the log has to survive service-worker eviction with the session.
    const stored = area.backing.get('session:7') as { log?: unknown[] };
    expect(stored.log).toHaveLength(2);
  });

  it('is a NO-OP for a tab with no session — logging must never fail a turn', async () => {
    const store = new SessionStore({ now: () => 1 });
    // `patch` throws for an unknown tab; `appendLog` must not, because it is called from the turn's
    // event fan-out where a throw would surface as a failed turn.
    await expect(store.appendLog(999, entry(1))).resolves.toBeUndefined();
  });

  it('ring-buffers at LOG_CAP rather than growing into the storage quota', async () => {
    const store = new SessionStore({ now: () => 1 });
    await store.ensure(7, 'https://example.com', SESSION_ID);

    for (let n = 0; n < LOG_CAP + 5; n += 1) await store.appendLog(7, entry(n));

    const log = store.get(7)?.log ?? [];
    expect(log).toHaveLength(LOG_CAP);
    // Oldest dropped, newest kept.
    expect(log[log.length - 1]?.text).toBe(`#${LOG_CAP + 4}`);
    expect(log.some((e) => e.text === '#0')).toBe(false);
  });

  it('starts a fresh session with an empty log', async () => {
    const store = new SessionStore({ now: () => 1 });
    const created = await store.ensure(7, 'https://example.com', SESSION_ID);
    expect(created.log).toEqual([]);
  });
});

describe('TurnSession schema back-compatibility', () => {
  it('parses a session persisted BEFORE the log field existed', () => {
    // The field is defaulted, not required, so an existing `chrome.storage.session` record from a
    // prior version must still hydrate instead of being dropped as stale-schema.
    const legacy = {
      tabId: 3,
      url: 'https://example.com',
      changeset: {
        url: 'https://example.com',
        createdAt: '2026-01-01T00:00:00.000Z',
        sessionId: SESSION_ID,
        edits: [],
      },
      updatedAt: 1,
    };
    const parsed = TurnSession.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.log).toEqual([]);
  });

  it('rehydrates a persisted log through hydrate()', async () => {
    const seeded = new SessionStore({ now: () => 1 });
    await seeded.ensure(7, 'https://example.com', SESSION_ID);
    await seeded.appendLog(7, entry(42));

    // A fresh store over the same backing store — the service worker waking up.
    const woken = new SessionStore({ now: () => 1 });
    await woken.hydrate();
    expect(woken.get(7)?.log.map((e) => e.text)).toEqual(['#42']);
  });
});
