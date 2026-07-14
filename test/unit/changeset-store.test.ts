import { describe, expect, it } from 'vitest';
import { ChangesetStore } from '@/changeset/store';
import { type Changeset, type Edit, emptyChangeset } from '@/shared/changeset';

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
