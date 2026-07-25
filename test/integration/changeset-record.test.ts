import { describe, expect, it } from 'vitest';
import { createSessionTools } from '@/agent/tools/session';
import { createPendingMutations, foldMutationEvents } from '@/changeset/pending-mutations';
import { ChangesetStore } from '@/changeset/store';
import { createDomExecutor } from '@/dom/execute';
import { createMutator } from '@/dom/mutate';
import { createRecorder } from '@/dom/recorder';
import { reduceChangeset } from '@/entrypoints/sidepanel/stores/changeset';
import { type ChatMessage, reduceChat } from '@/entrypoints/sidepanel/stores/chat';
import { Changeset, type ChangesetState, type Edit, emptyChangeset } from '@/shared/changeset';
import {
  type ContentToSw,
  MutationEvent,
  type MutationKind,
  type SwToPanel,
  type ToolResult,
} from '@/shared/messages';
import { relayToPanel } from '@/shared/relay';

// Integration — the changeset FOLD-BACK seam: an accepted live edit travels content -> SW -> panel.
// A real DOM mutation (createDomExecutor + createMutator + createRecorder on jsdom, exactly as
// dom-execute.test.ts drives it) produces a GENUINE `recorder-event` (ContentToSw), and that same
// accepted change is folded into a per-tab `ChangesetStore` through the REAL `recordEdit`/`undo`/
// `redo` session tools; the store's `emit` port (the `edit-recorded`/`changeset` SwToPanel stream)
// is folded by the REAL panel stores (`stores/chat.ts` reduceChat, `stores/changeset.ts`
// reduceChangeset). Nothing here is mocked but the two capture arrays and the wiring that
// reproduces background.ts's `user-message` case (it constructs the ChangesetStore + createSessionTools
// with `emit: postToPanel` — background.ts imports the WXT `#imports` virtual module and can't be
// imported under Vitest, so the wiring is reproduced 1:1).
//
// REAL vs faked: real = dom executor/mutator/recorder, ChangesetStore, createSessionTools,
// relayToPanel, panel reduceChat/reduceChangeset, the #9 pending-mutations buffer + fold, all Zod
// schemas. Faked = the ContentToSw/SwToPanel capture arrays, the in-memory persister/session
// mirrors, and the wiring that reproduces background.ts 1:1. Note the actual code path:
// background.ts folds the intent-tagged `Edit` via the `recordEdit` tool — since #9 draining the
// tab's buffered recorder events into it (ground truth per mechanical family) — while the raw
// `recorder-event` itself is never relayed to the panel (relay.ts — asserted here too); the two
// are distinct records of the one accepted mutation. The second describe covers the #9 SW-side
// consumer end-to-end: recorder-event buffer → recordEdit fold, turn-end auto-finalize of
// leftovers, and nav-clear wiping the edits (not the thread) on a main-frame commit.

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
// The fresh sessionId nav-clear re-seeds the session mirror with (a navigation starts a new
// handoff idempotency key).
const NAV_SESSION_ID = '9b1f4c2a-6d3e-4f58-a1b2-7c8d9e0f1a2b';
const URL = 'http://localhost:3000/pricing';
// The tab every harness piece is keyed to (background.ts keys buffer/persister/session by tab).
const TAB_ID = 42;

const data = <T>(r: ToolResult): T => r.data as T;

// A #9-producer-shaped recorder event, validated against the real MutationEvent schema so the
// tests can never drift from the contract the content side ships.
const recorderEventOf = (
  kind: MutationKind,
  selectorValue: string,
  extra: Partial<MutationEvent> = {},
): MutationEvent =>
  MutationEvent.parse({
    kind,
    selector: { value: selectorValue, strategy: 'id', fragile: false },
    before: '',
    after: '',
    ts: 1,
    ...extra,
  });

// Mirror background.ts's user-message changeset wiring: a per-tab ChangesetStore + the session
// tools bound to it, with `emit` = postToPanel (captured), `persist` = BOTH mirrors background.ts
// writes (the undo/redo persister `changeset:<tabId>` + the SessionStore resume snapshot), and
// `drainRecorderEvents` = the tab's #9 pending-mutations buffer (what the SW content-push
// listener appends to). `finalizeTurn`/`navClear` reproduce the turn-done auto-finalize and the
// webNavigation onCommitted wipe 1:1 (background.ts can't be imported under Vitest).
function makeSw() {
  const toPanel: SwToPanel[] = [];
  const persisted: Changeset[] = [];
  const store = new ChangesetStore(emptyChangeset(URL, '2026-07-14T00:00:00Z', SESSION_ID));
  const pending = createPendingMutations();
  // In-memory stand-ins for `createSessionChangesetPersister` (save/load/clear) and the
  // SessionStore's per-tab record (changeset mirror + the message thread nav-clear must keep).
  let persisterState: ChangesetState | undefined;
  const persister = {
    save: (state: ChangesetState): void => {
      persisterState = state;
    },
    load: (): ChangesetState | undefined => persisterState,
    clear: (): void => {
      persisterState = undefined;
    },
  };
  const sessionMirror: { changeset: Changeset; messages: string[] } = {
    changeset: store.current,
    messages: ['user: make the CTA pop'],
  };
  // background.ts's named `persistChangeset` closure (persister snapshot + SessionStore mirror).
  const persistChangeset = (): void => {
    const snapshot = store.snapshot();
    persister.save(snapshot);
    sessionMirror.changeset = snapshot.changeset;
    persisted.push(snapshot.changeset);
  };
  const tools = createSessionTools({
    store,
    persist: persistChangeset,
    emit: (event) => toPanel.push(event),
    drainRecorderEvents: (selectorValue) => pending.drain(TAB_ID, selectorValue),
  });
  // background.ts's turn-done auto-finalize: one "Auto-recorded" Edit per leftover selector
  // group, recorded + persisted + streamed like a model-recorded edit; then the buffer is wiped.
  const finalizeTurn = (): void => {
    for (const group of pending.peekGroups(TAB_ID)) {
      const edit = foldMutationEvents(
        {
          intent: 'Auto-recorded agent edit (no recordEdit call)',
          selector: group.selector,
          changes: [],
          attrs: [],
          classes: [],
          frameworkHints: [],
        },
        group.events,
      );
      store.record(edit);
      persistChangeset();
      toPanel.push({ type: 'edit-recorded', edit });
    }
    pending.clear(TAB_ID);
  };
  // background.ts's webNavigation onCommitted nav-clear (main frame): wipe the buffer + both
  // changeset mirrors, re-seed the session mirror EMPTY for the new URL — thread survives.
  const navClear = (url: string): void => {
    pending.clear(TAB_ID);
    persister.clear();
    sessionMirror.changeset = emptyChangeset(url, '2026-07-15T00:00:00Z', NAV_SESSION_ID);
  };
  return {
    store,
    tools,
    toPanel,
    persisted,
    pending,
    persister,
    sessionMirror,
    finalizeTurn,
    navClear,
  };
}

// A live jsdom edit driven through the real executor -> a genuine recorder-event on the content bus.
function driveMutation(html: string): {
  emitted: ContentToSw[];
  exec: ReturnType<typeof createDomExecutor>['exec'];
} {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
  const emitted: ContentToSw[] = [];
  const recorder = createRecorder(
    (m) => emitted.push(m),
    () => 1_752_460_800_000,
  );
  const executor = createDomExecutor({ mutator: createMutator(document), recorder, doc: document });
  return { emitted, exec: executor.exec };
}

const runTool = (execute: unknown, input: unknown): Promise<ToolResult> =>
  (execute as (i: unknown, o: Record<string, unknown>) => Promise<ToolResult>)(input, {});

describe('changeset fold-back: recorder mutation -> SW ChangesetStore -> panel stores', () => {
  it('folds a real edit into the store and streams edit-recorded into the panel chat store', async () => {
    // 1) A genuine live mutation produces a real recorder-event on the content bus.
    const { emitted, exec } = driveMutation('<button id="cta">Buy</button>');
    const applied = exec({ type: 'setStyle', selector: '#cta', props: { color: 'rgb(1, 2, 3)' } });
    expect(applied.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const recorderEvent = emitted[0];
    if (recorderEvent?.type !== 'recorder-event') throw new Error('expected a recorder-event');
    expect(recorderEvent.event.kind).toBe('setStyle');

    // The raw recorder-event is NOT relayed to the panel (relay.ts) — no panel store consumes it;
    // the fold-back reaches the panel as an intent-tagged `edit-recorded` via `recordEdit` below.
    expect(relayToPanel(recorderEvent)).toBeNull();

    // 2) The accepted change is recorded as an intent-tagged Edit, GROUNDED in the recorder-event's
    // real selector, through the REAL recordEdit tool into the real ChangesetStore.
    const { store, tools, toPanel, persisted } = makeSw();
    const edit: Edit = {
      intent: 'Make the primary CTA blue',
      selector: recorderEvent.event.selector,
      changes: [{ prop: 'color', before: recorderEvent.event.before, after: 'rgb(1, 2, 3)' }],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    const res = await runTool(tools.recordEdit.execute, edit);
    expect(res.ok).toBe(true);
    expect(data<{ edits: number }>(res).edits).toBe(1);

    // The store now holds a valid Changeset entry shaped end-to-end.
    const parsed = Changeset.safeParse(store.current);
    expect(parsed.success).toBe(true);
    expect(store.current.edits).toHaveLength(1);
    expect(store.current.edits[0]?.selector.value).toBe('#cta');
    expect(store.current.edits[0]?.changes[0]?.after).toBe('rgb(1, 2, 3)');
    // Persisted to the SessionStore mirror (background.ts's `persist` port).
    expect(persisted.at(-1)?.edits).toHaveLength(1);

    // 3) The emitted `edit-recorded` folds into the REAL panel chat store's in-flight bubble.
    let messages: ChatMessage[] = reduceChat([], { type: 'token', text: 'Recorded that edit.' });
    for (const msg of toPanel) messages = reduceChat(messages, msg);
    const assistant = messages.at(-1);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.edits).toEqual([edit]);
  });

  it('drives undo/redo through the store and reflects the full changeset in the panel changeset store', async () => {
    const { store, tools, toPanel } = makeSw();
    const edit: Edit = {
      intent: 'Bump the heading size',
      selector: { value: '#h', strategy: 'id', fragile: false },
      changes: [{ prop: 'font-size', before: '16px', after: '24px' }],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(tools.recordEdit.execute, edit);

    // recordEdit emits `edit-recorded` (not `changeset`), so the panel changeset store is still empty:
    // it only adopts a full `changeset` push (real reduceChangeset behaviour).
    let changeset = toPanel.reduce<Changeset | null>((acc, m) => reduceChangeset(acc, m), null);
    expect(changeset).toBeNull();

    // undo removes the edit and streams the full changeset -> the panel store adopts the empty set.
    const undo = await runTool(tools.undo.execute, {});
    expect(data<{ undone: boolean }>(undo).undone).toBe(true);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(true);
    changeset = toPanel.reduce<Changeset | null>((acc, m) => reduceChangeset(acc, m), null);
    expect(changeset?.edits).toEqual([]);

    // redo re-applies it and streams again -> the panel store reflects the restored edit end-to-end.
    const redo = await runTool(tools.redo.execute, {});
    expect(data<{ redone: boolean }>(redo).redone).toBe(true);
    expect(store.current.edits).toHaveLength(1);
    changeset = toPanel.reduce<Changeset | null>((acc, m) => reduceChangeset(acc, m), null);
    expect(changeset?.edits).toHaveLength(1);
    expect(changeset?.edits[0]?.changes[0]?.after).toBe('24px');
    expect(changeset?.sessionId).toBe(SESSION_ID);
  });
});

describe('#9 SW-side recorder consumer: buffer -> recordEdit fold / turn-end finalize / nav-clear', () => {
  it('folds buffered recorder events’ real attrs/classes/structural into the durable Edit', async () => {
    const { store, tools, toPanel, persisted, pending } = makeSw();
    // The SW content-push listener buffers the #9 producer's enriched events per tab.
    pending.append(
      TAB_ID,
      recorderEventOf('setAttr', '#cta', {
        attrChange: { name: 'data-variant', before: null, after: 'brand' },
      }),
    );
    pending.append(
      TAB_ID,
      recorderEventOf('addClass', '#cta', {
        classChange: { name: 'btn-primary', op: 'add' },
        frameworkHints: ['tailwind'],
      }),
    );
    pending.append(
      TAB_ID,
      recorderEventOf('insertNode', '#cta', {
        structural: { op: 'insert', html: '<span class="badge">new</span>', position: 'beforeend' },
      }),
    );

    // The model's Edit restates the attr WRONG and omits the class/structural deltas entirely —
    // ground truth wins for every family the buffer supplied.
    const edit: Edit = {
      intent: 'Brand the CTA',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
      attrs: [{ name: 'data-variant', before: null, after: 'model-said' }],
      classes: [],
      frameworkHints: [],
    };
    const res = await runTool(tools.recordEdit.execute, edit);
    expect(res.ok).toBe(true);

    const recorded = store.current.edits[0];
    expect(recorded?.attrs).toEqual([{ name: 'data-variant', before: null, after: 'brand' }]);
    expect(recorded?.classes).toEqual([{ name: 'btn-primary', op: 'add' }]);
    expect(recorded?.structural).toEqual({
      op: 'insert',
      html: '<span class="badge">new</span>',
      position: 'beforeend',
    });
    // Unsupplied families keep the model's values; hints are the union.
    expect(recorded?.changes).toEqual(edit.changes);
    expect(recorded?.frameworkHints).toEqual(['tailwind']);
    // The fold consumed the buffer for that selector…
    expect(pending.peekGroups(TAB_ID)).toEqual([]);
    // …and the FOLDED edit is what streams to the panel + persists, shaped end-to-end.
    expect(toPanel).toContainEqual({ type: 'edit-recorded', edit: recorded });
    expect(persisted.at(-1)?.edits[0]?.structural).toEqual(recorded?.structural);
    expect(Changeset.safeParse(store.current).success).toBe(true);
  });

  it('a genuine pre-#9 recorder event leaves the model’s Edit standing (back-compat)', async () => {
    // A real jsdom mutation through the real executor/recorder — then strip the #9 typed fields
    // to reconstruct the PRE-#9 event shape (the post-#9 producer always emits them).
    const { emitted, exec } = driveMutation('<button id="cta">Buy</button>');
    const applied = exec({ type: 'setStyle', selector: '#cta', props: { color: 'rgb(1, 2, 3)' } });
    expect(applied.ok).toBe(true);
    const genuine = emitted[0];
    if (genuine?.type !== 'recorder-event') throw new Error('expected a recorder-event');
    const {
      styleChanges: _sc,
      attrChange: _ac,
      classChange: _cc,
      structural: _st,
      textChange: _tc,
      frameworkHints: _fh,
      ...legacy
    } = genuine.event;
    expect('styleChanges' in legacy).toBe(false);
    expect('attrChange' in legacy).toBe(false);

    const { store, tools, pending } = makeSw();
    pending.append(TAB_ID, legacy);
    const edit: Edit = {
      intent: 'Make the primary CTA blue',
      selector: genuine.event.selector,
      changes: [{ prop: 'color', before: genuine.event.before, after: 'rgb(1, 2, 3)' }],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };

    const res = await runTool(tools.recordEdit.execute, edit);

    expect(res.ok).toBe(true);
    expect(store.current.edits[0]).toEqual(edit); // drained, but nothing to fold — Edit stands
    expect(pending.peekGroups(TAB_ID)).toEqual([]);
  });

  it('turn-end auto-finalize records one folded Edit per leftover selector group, then wipes', () => {
    const { store, toPanel, persisted, pending, finalizeTurn } = makeSw();
    // The model mutated two elements but never called recordEdit for either.
    pending.append(
      TAB_ID,
      recorderEventOf('setAttr', '#cta', {
        attrChange: { name: 'data-variant', before: null, after: 'brand' },
      }),
    );
    pending.append(
      TAB_ID,
      recorderEventOf('addClass', '#cta', { classChange: { name: 'btn-primary', op: 'add' } }),
    );
    pending.append(
      TAB_ID,
      recorderEventOf('setStyle', '#nav', {
        styleChanges: [{ prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(9, 9, 9)' }],
      }),
    );

    finalizeTurn();

    expect(store.current.edits).toHaveLength(2);
    const [cta, nav] = store.current.edits;
    expect(cta?.intent).toBe('Auto-recorded agent edit (no recordEdit call)');
    expect(cta?.selector.value).toBe('#cta');
    expect(cta?.attrs).toEqual([{ name: 'data-variant', before: null, after: 'brand' }]);
    expect(cta?.classes).toEqual([{ name: 'btn-primary', op: 'add' }]);
    expect(nav?.intent).toBe('Auto-recorded agent edit (no recordEdit call)');
    expect(nav?.selector.value).toBe('#nav');
    expect(nav?.changes).toEqual([
      { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(9, 9, 9)' },
    ]);
    // Streamed + persisted exactly like model-recorded edits; buffer empty; changeset valid.
    expect(toPanel.filter((m) => m.type === 'edit-recorded')).toHaveLength(2);
    expect(persisted.at(-1)?.edits).toHaveLength(2);
    expect(pending.peekGroups(TAB_ID)).toEqual([]);
    expect(Changeset.safeParse(store.current).success).toBe(true);
  });

  it('nav-clear wipes the tab’s edits + buffer on a main-frame commit but keeps the thread', async () => {
    const { tools, pending, persister, sessionMirror, navClear } = makeSw();
    const edit: Edit = {
      intent: 'Make the primary CTA blue',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(tools.recordEdit.execute, edit);
    pending.append(
      TAB_ID,
      recorderEventOf('addClass', '#cta', { classChange: { name: 'late', op: 'add' } }),
    );
    expect(persister.load()?.changeset.edits).toHaveLength(1);
    expect(sessionMirror.changeset.edits).toHaveLength(1);

    navClear('http://localhost:3000/other');

    // BOTH mirrors wiped (turn start falls back to the session mirror when the persister is
    // empty — re-seeding it EMPTY for the new URL is what stops the old edits resurrecting).
    expect(persister.load()).toBeUndefined();
    expect(sessionMirror.changeset.edits).toEqual([]);
    expect(sessionMirror.changeset.url).toBe('http://localhost:3000/other');
    expect(sessionMirror.changeset.sessionId).toBe(NAV_SESSION_ID);
    expect(sessionMirror.changeset.sessionId).not.toBe(SESSION_ID);
    // The recorder buffer is gone too — but the conversation thread survives the navigation.
    expect(pending.peekGroups(TAB_ID)).toEqual([]);
    expect(sessionMirror.messages).toEqual(['user: make the CTA pop']);
  });
});
