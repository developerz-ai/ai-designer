import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingSnapshot } from '@/changeset/pending-mutations';
import {
  createPendingMutationsPersister,
  PENDING_PERSIST_DEBOUNCE_MS,
} from '@/changeset/pending-persist';
import type { SessionStorageArea } from '@/changeset/store';
import type { MutationEvent } from '@/shared/messages';

// pending-persist unit (#148 item 3): the chrome.storage.session mirror for the recorder buffer.
// Pins the write cadence (appends debounced trailing-edge with only the LATEST snapshot written;
// drain/remove/clear written through, cancelling any pending trailing append), the null⇒remove
// contract, and loadAll's validation (prefix filter, Zod drop + best-effort delete of mangled
// records, non-numeric tab keys dropped).

const event = (selectorValue: string): MutationEvent => ({
  kind: 'setStyle',
  selector: { value: selectorValue, strategy: 'id', fragile: false },
  before: '',
  after: '',
  ts: 1,
});

const snap = (...values: string[]): PendingSnapshot => ({
  events: values.map(event),
  dropped: 0,
});

function fakeArea() {
  const store = new Map<string, unknown>();
  const area: SessionStorageArea = {
    get: (keys) => {
      const names = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (store.has(name)) out[name] = store.get(name);
      return Promise.resolve(out);
    },
    set: (items) => {
      for (const [k, v] of Object.entries(items)) store.set(k, JSON.parse(JSON.stringify(v)));
      return Promise.resolve();
    },
    remove: (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      return Promise.resolve();
    },
  };
  return { store, area };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createPendingMutationsPersister: write cadence', () => {
  it('debounces appends and writes only the latest snapshot', async () => {
    const { store, area } = fakeArea();
    const persister = createPendingMutationsPersister(area);
    persister.save(7, snap('#a'), 'append');
    persister.save(7, snap('#a', '#b'), 'append');
    expect(store.size).toBe(0); // nothing lands inside the debounce window
    await vi.advanceTimersByTimeAsync(PENDING_PERSIST_DEBOUNCE_MS);
    expect(store.size).toBe(1);
    expect((store.get('pendingMutations:7') as PendingSnapshot).events).toHaveLength(2);
  });

  it('writes drain/remove through immediately and cancels the trailing append', async () => {
    const { store, area } = fakeArea();
    const persister = createPendingMutationsPersister(area);
    persister.save(7, snap('#a', '#b'), 'append');
    persister.save(7, snap('#b'), 'drain'); // recordEdit drained #a
    await vi.advanceTimersByTimeAsync(0);
    expect((store.get('pendingMutations:7') as PendingSnapshot).events).toHaveLength(1);
    // The cancelled trailing append must not overwrite the drained state later.
    await vi.advanceTimersByTimeAsync(PENDING_PERSIST_DEBOUNCE_MS * 2);
    expect((store.get('pendingMutations:7') as PendingSnapshot).events).toHaveLength(1);
  });

  it('a null snapshot removes the key (clear / tab close)', async () => {
    const { store, area } = fakeArea();
    const persister = createPendingMutationsPersister(area);
    persister.save(7, snap('#a'), 'append');
    persister.save(7, null, 'clear');
    await vi.advanceTimersByTimeAsync(PENDING_PERSIST_DEBOUNCE_MS * 2);
    expect(store.size).toBe(0);
  });

  it('keeps tabs independent — one tab’s debounce never delays another’s', async () => {
    const { store, area } = fakeArea();
    const persister = createPendingMutationsPersister(area);
    persister.save(7, snap('#a'), 'append');
    persister.save(9, snap('#z'), 'drain');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.has('pendingMutations:9')).toBe(true);
    expect(store.has('pendingMutations:7')).toBe(false);
    await vi.advanceTimersByTimeAsync(PENDING_PERSIST_DEBOUNCE_MS);
    expect(store.has('pendingMutations:7')).toBe(true);
  });

  it('never throws on a failing storage area', async () => {
    const failing: SessionStorageArea = {
      get: () => Promise.reject(new Error('quota')),
      set: () => Promise.reject(new Error('quota')),
      remove: () => Promise.reject(new Error('quota')),
    };
    const persister = createPendingMutationsPersister(failing);
    expect(() => persister.save(7, snap('#a'), 'drain')).not.toThrow();
    expect(() => persister.save(7, null, 'clear')).not.toThrow();
    await vi.advanceTimersByTimeAsync(PENDING_PERSIST_DEBOUNCE_MS * 2);
  });
});

describe('createPendingMutationsPersister: loadAll', () => {
  it('restores valid snapshots per tab and ignores foreign keys', async () => {
    const { store, area } = fakeArea();
    store.set('pendingMutations:7', snap('#a', '#b'));
    store.set('pendingMutations:9', { ...snap('#z'), dropped: 3 });
    store.set('changeset:7', { anything: true });
    const restored = await createPendingMutationsPersister(area).loadAll();
    expect([...restored.keys()].sort()).toEqual([7, 9]);
    expect(restored.get(7)?.events).toHaveLength(2);
    expect(restored.get(9)?.dropped).toBe(3);
  });

  it('drops (and deletes) mangled records and non-numeric tab keys', async () => {
    const { store, area } = fakeArea();
    store.set('pendingMutations:7', { events: [{ nonsense: true }], dropped: 0 });
    store.set('pendingMutations:oops', snap('#a'));
    const restored = await createPendingMutationsPersister(area).loadAll();
    expect(restored.size).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.has('pendingMutations:7')).toBe(false);
  });
});
