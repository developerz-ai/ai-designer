import { describe, expect, it } from 'vitest';
import { applyChangesetOp, type ChangesetPorts, readChangeset } from '@/changeset/panel-ops';
import { type Changeset, type ChangesetState, type Edit, emptyChangeset } from '@/shared/changeset';
import type { MutationEvent } from '@/shared/messages';

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

// Round-4 retract op: the background recorder-revert path matches + strips the durable record
// through the SAME one-load machinery (the old double-load match-then-remove TOCTOU is gone).
describe('applyChangesetOp retract (round-4 surgical late-revert)', () => {
  const editWith = (intent: string, overrides: Partial<Edit> = {}): Edit => ({
    ...edit(intent),
    ...overrides,
  });
  const styleEvent = (
    selectorValue: string,
    prop: string,
    before: string | null,
    after: string,
  ): MutationEvent => ({
    kind: 'setStyle',
    selector: { value: selectorValue, strategy: 'id', fragile: false },
    before: '',
    after: '',
    ts: 1,
    styleChanges: [{ prop, before, after }],
  });

  it('strips the reverted family from the matched edit — ONE load, one save, one mirror', async () => {
    const base = editWith('a', {
      changes: [
        { prop: 'color', before: '#000', after: '#00f' },
        { prop: 'margin', before: null, after: '8px' },
      ],
    });
    const { ports, mirrored, current } = fakePorts({
      changeset: { ...seed(), edits: [base] },
      redoStack: [],
    });
    let loads = 0;
    let saves = 0;
    const counted: ChangesetPorts = {
      load: () => {
        loads++;
        return ports.load();
      },
      save: (s) => {
        saves++;
        return ports.save(s);
      },
      mirror: ports.mirror,
    };

    const v = await applyChangesetOp(counted, {
      kind: 'retract',
      event: styleEvent('#a', 'color', '#000', '#00f'),
    });

    // color restored to its original ⇒ the pair died; margin survives in place.
    expect(v.changeset?.edits).toHaveLength(1);
    expect(v.changeset?.edits[0]?.changes).toEqual([
      { prop: 'margin', before: null, after: '8px' },
    ]);
    expect(loads).toBe(1);
    expect(saves).toBe(1);
    expect(mirrored).toHaveLength(1);
    expect(intents(mirrored[0] ?? null)).toEqual(['a']);
    expect(current()?.changeset.edits[0]?.changes).toEqual([
      { prop: 'margin', before: null, after: '8px' },
    ]);
  });

  it('removes the edit when the strip empties every family', async () => {
    const { ports, mirrored, current } = fakePorts(stateWith('x', 'y'));
    // edit('y') holds only {color, before null, after '#000'}; reverting that add empties it.
    const v = await applyChangesetOp(ports, {
      kind: 'retract',
      event: styleEvent('#y', 'color', null, '#000'),
    });
    expect(intents(v.changeset)).toEqual(['x']);
    expect(current()?.changeset.edits.map((e) => e.intent)).toEqual(['x']);
    expect(intents(mirrored.at(-1) ?? null)).toEqual(['x']);
  });

  it('a miss is a true no-op — pre-op view, nothing persisted or mirrored', async () => {
    const { ports, mirrored, current } = fakePorts(stateWith('x'));
    let saves = 0;
    const counted: ChangesetPorts = {
      load: ports.load,
      save: (s) => {
        saves++;
        return ports.save(s);
      },
      mirror: ports.mirror,
    };

    const v = await applyChangesetOp(counted, {
      kind: 'retract',
      event: styleEvent('#nope', 'color', null, '#000'),
    });

    expect(intents(v.changeset)).toEqual(['x']);
    expect(v.busy).toBeUndefined();
    expect(saves).toBe(0);
    expect(mirrored).toEqual([]);
    expect(current()?.changeset.edits.map((e) => e.intent)).toEqual(['x']);
  });

  it('strips the LAST consistent edit when several match (LIFO unwind)', async () => {
    const older = editWith('older', {
      selector: { value: '#dup', strategy: 'id', fragile: false },
    });
    const newer = editWith('newer', {
      selector: { value: '#dup', strategy: 'id', fragile: false },
    });
    const { ports } = fakePorts({ changeset: { ...seed(), edits: [older, newer] }, redoStack: [] });

    const v = await applyChangesetOp(ports, {
      kind: 'retract',
      event: styleEvent('#dup', 'color', null, '#000'),
    });

    // The newest consistent edit died (its only family emptied); the older stands untouched.
    expect(intents(v.changeset)).toEqual(['older']);
  });

  it('a setAttr(class) revert matches + strips the classes family (round-4 matcher mirror)', async () => {
    const withClasses = editWith('c', {
      changes: [],
      classes: [{ name: 'hero', op: 'add' }],
    });
    const { ports } = fakePorts({
      changeset: { ...seed(), edits: [withClasses] },
      redoStack: [],
    });
    const event: MutationEvent = {
      kind: 'setAttr',
      selector: { value: '#c', strategy: 'id', fragile: false },
      before: '',
      after: '',
      ts: 1,
      attrChange: { name: 'class', before: '', after: 'hero' },
    };

    const v = await applyChangesetOp(ports, { kind: 'retract', event });

    expect(intents(v.changeset)).toEqual([]); // classes was the only family ⇒ the edit died
  });
});
