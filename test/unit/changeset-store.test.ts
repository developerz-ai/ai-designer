import { describe, expect, it } from 'vitest';
import {
  ChangesetStore,
  createSessionChangesetPersister,
  type SessionStorageArea,
} from '@/changeset/store';
import { type Changeset, type ChangesetState, type Edit, emptyChangeset } from '@/shared/changeset';

// changeset/store.ts unit: the session's live changeset with a linear undo/redo history. Pure and
// chrome-free — no storage fake needed (the SessionStore owns durability; see session.test.ts).

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const seed = (): Changeset =>
  emptyChangeset('https://example.com/pricing', '2026-07-13T00:00:00Z', SESSION_ID);

// A minimal valid Edit tagged by intent so tests can assert history order by name.
const edit = (intent: string): Edit => ({
  intent,
  selector: { value: `#${intent}`, strategy: 'id', fragile: false },
  changes: [{ prop: 'color', before: null, after: '#000' }],
  attrs: [],
  classes: [],
  frameworkHints: [],
});

const intents = (cs: Changeset): string[] => cs.edits.map((e) => e.intent);

describe('ChangesetStore.record', () => {
  it('appends edits and reports size / canUndo', () => {
    const store = new ChangesetStore(seed());
    expect(store.size).toBe(0);
    expect(store.canUndo).toBe(false);

    store.record(edit('a'));
    store.record(edit('b'));

    expect(store.size).toBe(2);
    expect(store.canUndo).toBe(true);
    expect(intents(store.current)).toEqual(['a', 'b']);
  });

  it('never mutates the seed changeset (immutable snapshots)', () => {
    const base = seed();
    const store = new ChangesetStore(base);
    store.record(edit('a'));
    expect(base.edits).toHaveLength(0); // the seed the caller still holds is untouched
    expect(store.current).not.toBe(base);
  });
});

describe('ChangesetStore undo/redo', () => {
  it('undo removes the last edit; redo re-applies it', () => {
    const store = new ChangesetStore(seed());
    store.record(edit('a'));
    store.record(edit('b'));

    const undone = store.undo();
    expect(undone?.intent).toBe('b');
    expect(intents(store.current)).toEqual(['a']);
    expect(store.canRedo).toBe(true);

    const redone = store.redo();
    expect(redone?.intent).toBe('b');
    expect(intents(store.current)).toEqual(['a', 'b']);
    expect(store.canRedo).toBe(false);
  });

  it('is LIFO across multiple undo/redo steps', () => {
    const store = new ChangesetStore(seed());
    store.record(edit('a'));
    store.record(edit('b'));
    store.record(edit('c'));

    store.undo(); // drop c
    store.undo(); // drop b
    expect(intents(store.current)).toEqual(['a']);

    store.redo(); // b back
    store.redo(); // c back
    expect(intents(store.current)).toEqual(['a', 'b', 'c']);
  });

  it('returns undefined when there is nothing to undo/redo', () => {
    const store = new ChangesetStore(seed());
    expect(store.undo()).toBeUndefined();
    expect(store.redo()).toBeUndefined();
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
  });

  it('a fresh record forks history — the redo tail is dropped', () => {
    const store = new ChangesetStore(seed());
    store.record(edit('a'));
    store.record(edit('b'));
    store.undo(); // b onto the redo stack
    expect(store.canRedo).toBe(true);

    store.record(edit('c')); // forks: the undone `b` is now unreachable
    expect(store.canRedo).toBe(false);
    expect(intents(store.current)).toEqual(['a', 'c']);
    expect(store.redo()).toBeUndefined();
  });
});

describe('ChangesetStore removeAt (diff-tab per-edit remove)', () => {
  it('removes the edit at an index and returns it', () => {
    const store = new ChangesetStore(seed());
    store.record(edit('a'));
    store.record(edit('b'));
    store.record(edit('c'));

    const removed = store.removeAt(1);
    expect(removed?.intent).toBe('b');
    expect(intents(store.current)).toEqual(['a', 'c']);
  });

  it('forks history — removing an edit drops the redo tail', () => {
    const store = new ChangesetStore(seed());
    store.record(edit('a'));
    store.record(edit('b'));
    store.undo(); // b -> redo stack
    expect(store.canRedo).toBe(true);

    store.removeAt(0); // drop a
    expect(store.canRedo).toBe(false);
    expect(intents(store.current)).toEqual([]);
    expect(store.redo()).toBeUndefined();
  });

  it('is a no-op for an out-of-range index', () => {
    const store = new ChangesetStore(seed());
    store.record(edit('a'));
    expect(store.removeAt(5)).toBeUndefined();
    expect(store.removeAt(-1)).toBeUndefined();
    expect(intents(store.current)).toEqual(['a']);
  });

  it('persists the new state via the port after a removal', () => {
    const states: ChangesetState[] = [];
    const store = new ChangesetStore(seed(), {
      persist: (s) => {
        states.push(s);
      },
    });
    store.record(edit('a'));
    store.record(edit('b'));
    store.removeAt(0);
    expect(states.at(-1)?.changeset.edits.map((e) => e.intent)).toEqual(['b']);
  });
});

describe('ChangesetStore clear (diff-tab clear session)', () => {
  it('wipes edits and the redo stack, keeping the changeset identity', () => {
    const store = new ChangesetStore(seed());
    store.record(edit('a'));
    store.record(edit('b'));
    store.undo(); // redo stack holds b
    const id = store.current.sessionId;

    store.clear();
    expect(store.size).toBe(0);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
    expect(store.current.sessionId).toBe(id); // same session — a later record continues it
  });

  it('persists the cleared state via the port', () => {
    const states: ChangesetState[] = [];
    const store = new ChangesetStore(seed(), {
      persist: (s) => {
        states.push(s);
      },
    });
    store.record(edit('a'));
    store.clear();
    expect(states.at(-1)?.changeset.edits).toEqual([]);
    expect(states.at(-1)?.redoStack).toEqual([]);
  });
});

describe('ChangesetStore serialization (full undo/redo state)', () => {
  it('snapshot captures the changeset AND the redo stack', () => {
    const store = new ChangesetStore(seed());
    store.record(edit('a'));
    store.record(edit('b'));
    store.undo(); // b -> redo stack

    const snap = store.snapshot();
    expect(intents(snap.changeset)).toEqual(['a']);
    expect(snap.redoStack.map((e) => e.intent)).toEqual(['b']);
  });

  it('fromState rehydrates undo/redo where it left off', () => {
    const original = new ChangesetStore(seed());
    original.record(edit('a'));
    original.record(edit('b'));
    original.undo(); // b undone, still redoable

    const restored = ChangesetStore.fromState(original.snapshot());
    expect(intents(restored.current)).toEqual(['a']);
    expect(restored.canRedo).toBe(true);
    expect(restored.redo()?.intent).toBe('b'); // the undone edit survived the round-trip
    expect(intents(restored.current)).toEqual(['a', 'b']);
  });

  it('snapshot is a copy — later store mutations do not leak into a held snapshot', () => {
    const store = new ChangesetStore(seed());
    store.record(edit('a'));
    store.undo();
    const snap = store.snapshot();
    store.redo(); // drains the redo stack after the snapshot was taken

    expect(snap.redoStack).toHaveLength(1); // held snapshot is unaffected
  });
});

describe('ChangesetStore persist port', () => {
  it('calls persist with the full state after every mutation', () => {
    const states: ChangesetState[] = [];
    const store = new ChangesetStore(seed(), {
      persist: (s) => {
        states.push(s);
      },
    });

    store.record(edit('a'));
    store.record(edit('b'));
    store.undo();

    expect(states).toHaveLength(3);
    expect(states.at(-1)?.changeset.edits.map((e) => e.intent)).toEqual(['a']);
    expect(states.at(-1)?.redoStack.map((e) => e.intent)).toEqual(['b']);
  });

  it('swallows a rejected async persist — the in-memory state stays authoritative', () => {
    const store = new ChangesetStore(seed(), { persist: () => Promise.reject(new Error('quota')) });
    expect(() => store.record(edit('a'))).not.toThrow();
    expect(store.size).toBe(1);
  });
});

// Minimal in-memory chrome.storage.session-shaped fake, round-tripping values through JSON to mirror
// storage serialization (mirrors test/unit/session.test.ts's fake, scoped to the persister's surface).
function fakeArea(): SessionStorageArea & { backing: Map<string, unknown> } {
  const backing = new Map<string, unknown>();
  return {
    backing,
    get(keys) {
      const names = keys == null ? [...backing.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (backing.has(name)) out[name] = backing.get(name);
      return Promise.resolve(out);
    },
    set(items) {
      for (const [name, value] of Object.entries(items))
        backing.set(name, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
    remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) backing.delete(k);
      return Promise.resolve();
    },
  };
}

describe('createSessionChangesetPersister (chrome.storage.session)', () => {
  it('save then load round-trips the full state, keyed by tab', async () => {
    const area = fakeArea();
    const store = new ChangesetStore(seed());
    store.record(edit('a'));
    store.record(edit('b'));
    store.undo();

    const persister = createSessionChangesetPersister(7, area);
    await persister.save(store.snapshot());

    expect([...area.backing.keys()]).toEqual(['changeset:7']);
    const loaded = await persister.load();
    expect(loaded?.changeset.edits.map((e) => e.intent)).toEqual(['a']);
    expect(loaded?.redoStack.map((e) => e.intent)).toEqual(['b']);
  });

  it('wiring save as the store persist port mirrors each mutation to storage', async () => {
    const area = fakeArea();
    const persister = createSessionChangesetPersister(3, area);
    const store = new ChangesetStore(seed(), { persist: persister.save });

    store.record(edit('a'));
    await Promise.resolve(); // let the fire-and-forget write settle

    const loaded = await persister.load();
    expect(loaded?.changeset.edits.map((e) => e.intent)).toEqual(['a']);
  });

  it('load returns undefined for an unknown tab', async () => {
    expect(await createSessionChangesetPersister(99, fakeArea()).load()).toBeUndefined();
  });

  it('load tolerates a legacy bare-Changeset record (empty redo tail)', async () => {
    const area = fakeArea();
    const bare: Changeset = { ...seed(), edits: [edit('a')] };
    area.backing.set('changeset:5', JSON.parse(JSON.stringify(bare)));

    const loaded = await createSessionChangesetPersister(5, area).load();
    expect(loaded?.changeset.edits.map((e) => e.intent)).toEqual(['a']);
    expect(loaded?.redoStack).toEqual([]);
  });

  it('load drops a corrupt record rather than trusting it', async () => {
    const area = fakeArea();
    area.backing.set('changeset:1', { nope: true });
    expect(await createSessionChangesetPersister(1, area).load()).toBeUndefined();
  });

  it('clear forgets the persisted state', async () => {
    const area = fakeArea();
    const persister = createSessionChangesetPersister(2, area);
    await persister.save({ changeset: seed(), redoStack: [] });
    await persister.clear();
    expect(await persister.load()).toBeUndefined();
  });
});
