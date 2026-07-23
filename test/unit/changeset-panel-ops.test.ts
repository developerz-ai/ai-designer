import { describe, expect, it } from 'vitest';
import { applyChangesetOp, type ChangesetPorts, readChangeset } from '@/changeset/panel-ops';
import { type Changeset, type ChangesetState, type Edit, emptyChangeset } from '@/shared/changeset';

// panel-ops.ts unit: the SW-side curation core behind the Diff tab, over injected in-memory ports
// (no chrome.*). Mirrors background.ts's persister + SessionStore-mirror wiring; `save` round-trips
// through JSON like chrome.storage.session does, `mirror` records the SessionStore write.

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const seed = (): Changeset =>
  emptyChangeset('https://example.com/pricing', '2026-07-13T00:00:00Z', SESSION_ID);

const edit = (intent: string): Edit => ({
  intent,
  selector: { value: `#${intent}`, strategy: 'id', fragile: false },
  changes: [{ prop: 'color', before: null, after: '#000' }],
  attrs: [],
  classes: [],
  frameworkHints: [],
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function fakePorts(initial?: ChangesetState) {
  let stored: ChangesetState | undefined = initial ? clone(initial) : undefined;
  const mirrored: Changeset[] = [];
  const ports: ChangesetPorts = {
    load: () => Promise.resolve(stored ? clone(stored) : undefined),
    save: (s) => {
      stored = clone(s);
    },
    mirror: (cs) => {
      mirrored.push(cs);
      return Promise.resolve();
    },
  };
  return { ports, mirrored, current: () => stored };
}

const stateWith = (...names: string[]): ChangesetState => ({
  changeset: { ...seed(), edits: names.map(edit) },
  redoStack: [],
});

const intents = (cs: Changeset | null): string[] => (cs ? cs.edits.map((e) => e.intent) : []);

describe('readChangeset', () => {
  it('returns the empty view when the tab has no persisted state', async () => {
    const { ports } = fakePorts();
    expect(await readChangeset(ports.load)).toEqual({
      changeset: null,
      canUndo: false,
      canRedo: false,
    });
  });

  it('reports the current changeset + canUndo/canRedo derived from the redo stack', async () => {
    const state: ChangesetState = {
      changeset: { ...seed(), edits: [edit('a')] },
      redoStack: [edit('b')],
    };
    const { ports } = fakePorts(state);
    const v = await readChangeset(ports.load);
    expect(intents(v.changeset)).toEqual(['a']);
    expect(v.canUndo).toBe(true);
    expect(v.canRedo).toBe(true);
  });
});

describe('applyChangesetOp', () => {
  it('no-ops for a tab with no state (nothing to curate)', async () => {
    const { ports, mirrored } = fakePorts();
    const v = await applyChangesetOp(ports, { kind: 'undo' });
    expect(v).toEqual({ changeset: null, canUndo: false, canRedo: false });
    expect(mirrored).toEqual([]);
  });

  it('undo drops the last edit, persists, and mirrors to the SessionStore', async () => {
    const { ports, mirrored, current } = fakePorts(stateWith('a', 'b'));
    const v = await applyChangesetOp(ports, { kind: 'undo' });
    expect(intents(v.changeset)).toEqual(['a']);
    expect(v.canRedo).toBe(true);
    expect(current()?.changeset.edits.map((e) => e.intent)).toEqual(['a']);
    expect(current()?.redoStack.map((e) => e.intent)).toEqual(['b']);
    expect(intents(mirrored.at(-1) ?? null)).toEqual(['a']);
  });

  it('redo re-applies the most recently undone edit', async () => {
    const { ports } = fakePorts({
      changeset: { ...seed(), edits: [edit('a')] },
      redoStack: [edit('b')],
    });
    const v = await applyChangesetOp(ports, { kind: 'redo' });
    expect(intents(v.changeset)).toEqual(['a', 'b']);
    expect(v.canRedo).toBe(false);
  });

  it('remove drops the edit at the given index', async () => {
    const { ports } = fakePorts(stateWith('a', 'b', 'c'));
    const v = await applyChangesetOp(ports, { kind: 'remove', index: 1 });
    expect(intents(v.changeset)).toEqual(['a', 'c']);
  });

  it('clear wipes the changeset and persists the empty state', async () => {
    const { ports, current } = fakePorts(stateWith('a', 'b'));
    const v = await applyChangesetOp(ports, { kind: 'clear' });
    expect(intents(v.changeset)).toEqual([]);
    expect(v.canUndo).toBe(false);
    expect(current()?.changeset.edits).toEqual([]);
  });

  // The post-load guard (background.ts re-checks `turnAbort`): a turn that started inside the load
  // window must win — the op aborts as busy BEFORE any mutation/persist/mirror (#141 review).
  it('a guard tripped after load aborts as busy, echoing the pre-op view with no persist/mirror', async () => {
    const { ports, mirrored, current } = fakePorts(stateWith('a', 'b'));
    let saves = 0;
    const guarded: ChangesetPorts = {
      load: ports.load,
      save: (s) => {
        saves++;
        return ports.save(s);
      },
      mirror: ports.mirror,
      guard: () => false,
    };
    const v = await applyChangesetOp(guarded, { kind: 'undo' });
    expect(v).toEqual({
      changeset: expect.any(Object),
      canUndo: true,
      canRedo: false,
      busy: true,
    });
    expect(intents(v.changeset)).toEqual(['a', 'b']); // pre-op view echoed
    expect(saves).toBe(0);
    expect(mirrored).toEqual([]);
    expect(current()?.changeset.edits.map((e) => e.intent)).toEqual(['a', 'b']);
  });

  it('a tripped guard on an empty store still reports busy (no state to echo)', async () => {
    const { ports } = fakePorts();
    const v = await applyChangesetOp({ ...ports, guard: () => false }, { kind: 'clear' });
    expect(v).toEqual({ changeset: null, canUndo: false, canRedo: false, busy: true });
  });

  it('a passing guard lets the op proceed normally', async () => {
    const { ports } = fakePorts(stateWith('a', 'b'));
    const v = await applyChangesetOp({ ...ports, guard: () => true }, { kind: 'undo' });
    expect(intents(v.changeset)).toEqual(['a']);
    expect(v.busy).toBeUndefined();
  });
});
