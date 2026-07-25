import { describe, expect, it } from 'vitest';
import { createSessionTools } from '@/agent/tools/session';
import { applyChangesetOp } from '@/changeset/panel-ops';
import { createPendingMutations, foldMutationEvents } from '@/changeset/pending-mutations';
import { retractFromEdits } from '@/changeset/revert-match';
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
// reproduces background.ts (it imports the WXT `#imports` virtual module and can't be imported
// under Vitest, so the wiring is reproduced 1:1).
//
// REAL vs faked: real = dom executor/mutator/recorder, ChangesetStore, createSessionTools,
// relayToPanel, panel reduceChat/reduceChangeset, the #9 pending-mutations buffer + fold, the
// late-revert retraction (revert-match + applyChangesetOp), all Zod schemas. Faked = the
// ContentToSw/SwToPanel capture arrays, the in-memory persister/session mirrors, and the
// wiring that reproduces background.ts 1:1. Note the actual code path: background.ts folds
// the intent-tagged `Edit` via the `recordEdit` tool — since #9 draining the tab's buffered
// recorder events into it (ground truth per mechanical family) — while the raw
// `recorder-event` itself is never relayed to the panel (relay.ts — asserted here too); the
// two are distinct records of the one accepted mutation. The second describe covers the #9
// SW-side consumer end-to-end: recorder-event buffer → recordEdit fold (incl. structural
// spillover + buffer-cap drop suffix), turn-end auto-finalize of leftovers (cap loss noted
// on the FIRST finalized edit only), recorder-revert removal (buffer hit AND the late-revert
// retraction of an already-drained durable edit), the gated single-group rescue, nav-clear
// (reload early-return vs cross-URL wipe), and the turn-start URL guard keyed to the last
// cross-document committed URL (same-document hash navigations keep the record).

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
// The fresh sessionId nav-clear re-seeds the session mirror with (a navigation starts a new
// handoff idempotency key).
const NAV_SESSION_ID = '9b1f4c2a-6d3e-4f58-a1b2-7c8d9e0f1a2b';
// The fresh sessionId the turn-start URL guard re-seeds a stale (cross-URL) record with.
const BOOT_SESSION_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
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

// Mirror background.ts's user-message changeset wiring 1:1: `bootTurn` is the turn start (the
// per-tab ChangesetStore rehydrate + the stale-record guard keyed to the last cross-document
// committed URL — read from the PERSISTED committedUrl first, then the in-memory stamp, then the
// live tabUrl, background.ts's user-message case) and builds the session tools with `emit` =
// postToPanel (captured), `persist` = BOTH mirrors background.ts writes (the undo/redo persister
// `changeset:<tabId>` + the SessionStore resume snapshot), and `drainRecorderEvents` = the tab's
// #9 pending-mutations buffer. `contentPush` is the content->SW push listener (recorder-event
// append / recorder-revert removal + late-revert retraction / relayToPanel); `finalizeTurn` the
// turn-done auto-finalize with the structural spillover split + the buffer-cap drop suffix on
// the FIRST finalized edit; `navClear` the webNavigation onCommitted listener with its
// document-identity stamps (in-memory + persisted) + iframe + reload early returns and the
// deferred wipe continuation's racing-turn re-check. `endTurn` clears the in-flight-turn flag
// (background.ts's turn `.finally`); `evict` simulates an SW eviction (in-memory stamps lost,
// the storage-backed ones survive). The harness omits only `emitRecord`'s tabId stamp on
// edit-recorded (a #141 Diff-view concern, covered by the panel store tests).
function makeSw() {
  const toPanel: SwToPanel[] = [];
  const persisted: Changeset[] = [];
  const pending = createPendingMutations();
  // background.ts's `lastCommittedUrl`: the last CROSS-DOCUMENT committed main-frame URL per
  // tab — the document-identity authority the turn-start URL guard compares against (stamped
  // on every main-frame commit, reloads included; a same-document hash/pushState navigation
  // never fires a commit and so never stales the record).
  const lastCommitted = new Map<number, string>();
  // background.ts's `committedUrl:<tabId>` chrome.storage.session mirror of the stamp (#9
  // review round 4): survives the SW eviction the in-memory map doesn't, so the woken
  // worker's URL guard still compares against the committed URL, not the live tab.url.
  const persistedCommitted = new Map<number, string>();
  // background.ts's `turnAbort !== null`: a turn is in flight from bootTurn until endTurn —
  // the mid-turn half of the retraction strips the turn's OWN store too (its next persist
  // would otherwise resurrect the phantom over the op's retraction).
  let turnInFlight = false;
  // The late-revert retraction runs async in background.ts (fire-and-forget off the push
  // listener); the harness tracks the in-flight promise so tests can await the settle.
  let retraction: Promise<void> = Promise.resolve();
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
    changeset: emptyChangeset(URL, '2026-07-14T00:00:00Z', SESSION_ID),
    messages: ['user: make the CTA pop'],
  };
  // Rebuilt by every `bootTurn` (background.ts constructs a fresh ChangesetStore + session tools
  // per user-message turn); the getters below always hand out the current turn's instances.
  let store: ChangesetStore;
  let tools: ReturnType<typeof createSessionTools>;
  // background.ts's named `persistChangeset` closure (persister snapshot + SessionStore mirror).
  const persistChangeset = (): void => {
    const snapshot = store.snapshot();
    persister.save(snapshot);
    sessionMirror.changeset = snapshot.changeset;
    persisted.push(snapshot.changeset);
  };
  // background.ts's user-message turn start: rehydrate the undo/redo-capable store from the
  // persister (falling back to the session mirror), and on a STALE record — the persister/mirror
  // holds a changeset for a URL the tab has since left — seed BOTH mirrors EMPTY for the tab's
  // current URL and drop the redo stack (it only references the old record's edits). Stale is
  // computed against the last CROSS-DOCUMENT committed URL: a same-document navigation (hash,
  // pushState) never fires a commit, leaves DOM + live edits intact, and must not wipe the
  // record (#9 review round 2). The committed URL is read from the PERSISTED storage mirror
  // FIRST (#9 review round 4 — it survives the SW eviction the in-memory map doesn't), then the
  // in-memory stamp; the live tabUrl is only the fallback when no commit was ever seen.
  const bootTurn = (tabUrl: string): void => {
    const priorState = persister.load();
    const prior = priorState?.changeset ?? sessionMirror.changeset;
    const stale =
      prior.url !== (persistedCommitted.get(TAB_ID) ?? lastCommitted.get(TAB_ID) ?? tabUrl);
    store = new ChangesetStore(
      stale ? emptyChangeset(tabUrl, '2026-07-16T00:00:00Z', BOOT_SESSION_ID) : prior,
      { redoStack: stale ? undefined : priorState?.redoStack },
    );
    if (stale) persistChangeset();
    tools = createSessionTools({
      store,
      persist: persistChangeset,
      emit: (event) => toPanel.push(event),
      drainRecorderEvents: (selectorValue) => pending.drain(TAB_ID, selectorValue),
    });
    // background.ts sets `turnAbort` + registers the turn's store for the mid-turn retraction.
    turnInFlight = true;
  };
  // background.ts's turn `.finally` (and session start/stop): the in-flight turn is over, so a
  // later retraction takes the op path alone — the between-turns coverage.
  const endTurn = (): void => {
    turnInFlight = false;
  };
  // SW-eviction simulator: the worker-lifetime in-memory stamps die with the worker; the
  // chrome.storage.session-backed records (the persister, the persisted committedUrl) survive.
  const evict = (): void => {
    lastCommitted.clear();
    turnInFlight = false;
  };
  // background.ts's `retractRevertedEdit` (#9 review round 4; shared matcher + fail-closed drop
  // + redo-tail preservation round 5): the buffer remove missed (the event was already drained by
  // recordEdit / auto-finalized), so the phantom lives in the DURABLE record. Route
  // `{kind:'retract', event}` through the REAL applyChangesetOp machinery the Diff-tab curation
  // RPCs drive — ONE load (the round-2 find-then-remove double-load was a TOCTOU window): the op
  // calls retractFromEdits, the ONE matcher both paths share (the newest consistent edit whose
  // strip CHANGES something wins; a fully-stripped edit is removed; when NO consistent edit
  // value-matches — a broken LIFO — the entries the event covers drop from the newest consistent
  // edit instead of keeping the phantom). Both splices pass `{ preserveRedo: true }` so a retract
  // of an unrelated edit never kills a redo tail. Persist + SessionStore mirror + tab-stamped
  // panel push come with it. When a turn is IN FLIGHT the same retraction then applies to the
  // turn's own in-memory store + persist — its next persist would otherwise resurrect the phantom
  // over the op's retraction. A miss is a silent no-op (the record may have been curated or
  // nav-cleared since the event drained).
  const retractRevertedEdit = async (event: MutationEvent): Promise<void> => {
    const view = await applyChangesetOp(
      {
        load: () => Promise.resolve(persister.load()),
        save: (next) => persister.save(next),
        mirror: (cs) => {
          sessionMirror.changeset = cs;
          return Promise.resolve();
        },
      },
      { kind: 'retract', event },
    );
    if (view.changeset)
      toPanel.push({ type: 'changeset', changeset: view.changeset, tabId: TAB_ID });
    if (turnInFlight) {
      const result = retractFromEdits(store.current.edits, event);
      if (result !== null) {
        if (result.edits.length < store.current.edits.length) {
          store.removeAt(result.changedIndex, { preserveRedo: true });
        } else {
          const stripped = result.edits[result.changedIndex];
          if (stripped) store.replaceAt(result.changedIndex, stripped, { preserveRedo: true });
        }
        persistChangeset();
      }
    }
  };
  // background.ts's content->SW push listener: buffer recorder events per sender tab; a
  // reverted mutation's event leaves the buffer (a successful undo killed the change — it must
  // never fold), and on a buffer MISS the already-drained durable edit is retracted instead;
  // relay whatever relayToPanel maps (never recorder-*) to the panel.
  const contentPush = (msg: ContentToSw, senderTabId: number = TAB_ID): void => {
    if (msg.type === 'recorder-event') pending.append(senderTabId, msg.event);
    if (msg.type === 'recorder-revert' && !pending.remove(senderTabId, msg.event)) {
      retraction = retractRevertedEdit(msg.event);
    }
    const out = relayToPanel(msg);
    if (out) toPanel.push(out);
  };
  // background.ts's turn-done auto-finalize: one "Auto-recorded" Edit per leftover selector
  // group — a group holding several structural ops SPLITS (first op folds, each additional op is
  // its own auto-recorded spillover Edit) — with events dropped at the buffer cap surfaced as an
  // intent suffix on the FIRST finalized edit only (the loss is tab-level); every edit recorded
  // + persisted + streamed like a model-recorded one. Then the buffer is wiped.
  const finalizeTurn = (): void => {
    const droppedAtCap = pending.droppedCount(TAB_ID);
    let capNote =
      droppedAtCap > 0 ? ` (+${droppedAtCap} earlier events dropped at buffer cap)` : '';
    for (const group of pending.peekGroups(TAB_ID)) {
      const { folded, spillover } = foldMutationEvents(
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
      for (const edit of [folded, ...spillover]) {
        const tagged = capNote ? { ...edit, intent: `${edit.intent}${capNote}` } : edit;
        capNote = ''; // tab-level loss: noted once, on the first finalized edit
        store.record(tagged);
        persistChangeset();
        toPanel.push({ type: 'edit-recorded', edit: tagged });
      }
    }
    pending.clear(TAB_ID);
  };
  // background.ts's webNavigation onCommitted nav-clear: EVERY main-frame commit stamps the
  // tab's document identity FIRST — BOTH the in-memory map and the chrome.storage.session
  // `committedUrl:<tabId>` mirror (all transitionTypes, reload included — the turn-start URL
  // guard compares against them); iframe commits return before the stamps; RELOADS return right
  // after them (a reload is not a navigation away — the record survives). A main-frame
  // cross-URL commit wipes the buffer, then the DEFERRED continuation (background.ts's
  // sessionsReady.then + the #9-round-4 race re-check) re-reads the persister BEFORE wiping:
  // when a racing turn start already re-seeded it for the NEW URL, the clear + reseed + panel
  // push are SKIPPED; otherwise BOTH mirrors are wiped and the session mirror is re-seeded
  // EMPTY for the new URL (fresh sessionId — the handoff idempotency key must not carry over).
  // Thread survives. Returns the continuation promise so tests can await the settle.
  const navClear = (details: {
    frameId: number;
    transitionType: string;
    url: string;
  }): Promise<void> => {
    if (details.frameId !== 0) return Promise.resolve();
    lastCommitted.set(TAB_ID, details.url);
    persistedCommitted.set(TAB_ID, details.url);
    if (details.transitionType === 'reload') return Promise.resolve();
    pending.clear(TAB_ID);
    return Promise.resolve().then(() => {
      const current = persister.load();
      if (current?.changeset.url === details.url) return; // a racing turn re-seeded — skip
      persister.clear();
      const reseeded = emptyChangeset(details.url, '2026-07-15T00:00:00Z', NAV_SESSION_ID);
      sessionMirror.changeset = reseeded;
      toPanel.push({ type: 'changeset', changeset: reseeded, tabId: TAB_ID });
    });
  };
  bootTurn(URL);
  return {
    get store() {
      return store;
    },
    get tools() {
      return tools;
    },
    get retraction() {
      return retraction;
    },
    toPanel,
    persisted,
    pending,
    persister,
    persistedCommitted,
    sessionMirror,
    bootTurn,
    endTurn,
    evict,
    contentPush,
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
        // The window set-diff reads the legacy classAttr strings (the real producer's shape).
        before: '',
        after: 'btn-primary',
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

  it('two insertNode ops on one selector: recordEdit records the folded edit PLUS one spillover', async () => {
    // Two GENUINE structural mutations on the same reference element — the real producer stamps
    // each event's `structural` delta (sanitized html + refSelector).
    const { emitted, exec } = driveMutation('<div id="cta"><b>hi</b></div>');
    const r1 = exec({
      type: 'insertNode',
      selector: '#cta',
      html: '<span class="badge">1</span>',
      position: 'beforeend',
    });
    expect(r1.ok).toBe(true);
    const r2 = exec({
      type: 'insertNode',
      selector: '#cta',
      html: '<span class="badge">2</span>',
      position: 'beforeend',
    });
    expect(r2.ok).toBe(true);
    expect(emitted).toHaveLength(2);
    const [e1, e2] = emitted;
    if (e1?.type !== 'recorder-event' || e2?.type !== 'recorder-event')
      throw new Error('expected recorder-events');

    const sw = makeSw();
    sw.contentPush(e1);
    sw.contentPush(e2);

    const edit: Edit = {
      intent: 'Add two badges to the CTA',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [],
      attrs: [],
      classes: [],
      frameworkHints: ['tailwind'], // the model's own hint — must NOT leak into the spillover
    };
    const res = await runTool(sw.tools.recordEdit.execute, edit);
    expect(res.ok).toBe(true);
    expect(data<{ edits: number }>(res).edits).toBe(2);

    // One Edit carries ONE structural op: the FIRST folds into the model's edit (ground truth
    // replaces the model's empty structural)…
    const [folded, spill] = sw.store.current.edits;
    expect(folded?.intent).toBe('Add two badges to the CTA');
    expect(folded?.structural).toEqual(e1.event.structural);
    expect(folded?.frameworkHints).toEqual(['tailwind']);
    // …and the ADDITIONAL op becomes its own auto-recorded Edit — never silently dropped (a
    // dropped op would ship a changeset that can't reconstruct the page).
    expect(spill?.intent).toBe('Auto-recorded structural edit (additional op on same selector)');
    expect(spill?.selector.value).toBe('#cta');
    expect(spill?.structural).toEqual(e2.event.structural);
    expect(spill?.changes).toEqual([]);
    expect(spill?.attrs).toEqual([]);
    expect(spill?.classes).toEqual([]);
    // Spillover hints are the GROUP's union only (page-grounded — the model's 'tailwind' stays out;
    // a bare jsdom div carries no hints of its own).
    expect(spill?.frameworkHints).toEqual([]);
    // Both edits stream + persist exactly like model-recorded ones; the fold drained the buffer.
    expect(sw.toPanel).toContainEqual({ type: 'edit-recorded', edit: folded });
    expect(sw.toPanel).toContainEqual({ type: 'edit-recorded', edit: spill });
    expect(sw.persisted.at(-1)?.edits).toHaveLength(2);
    expect(sw.pending.peekGroups(TAB_ID)).toEqual([]);
    expect(Changeset.safeParse(sw.store.current).success).toBe(true);
  });

  it('recordEdit with a plausible paraphrased selector still folds via the gated rescue (no duplicate)', async () => {
    const { emitted, exec } = driveMutation('<button id="cta">Buy</button>');
    const applied = exec({ type: 'addClass', selector: '#cta', name: 'btn-primary' });
    expect(applied.ok).toBe(true);
    const genuine = emitted[0];
    if (genuine?.type !== 'recorder-event') throw new Error('expected a recorder-event');
    expect(genuine.event.selector.value).toBe('#cta');

    const sw = makeSw();
    sw.contentPush(genuine); // buffered under '#cta' — the ONLY group in the buffer

    // The model names its own paraphrase — NOT the buffered '#cta', but a PLAUSIBLE one (the
    // group value is a substring of the model value), so the gated single-group rescue
    // (pending-mutations.ts) treats it as unambiguous and drains anyway.
    const edit: Edit = {
      intent: 'Brand the CTA',
      selector: { value: 'button#cta', strategy: 'css-path', fragile: false },
      changes: [],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    const res = await runTool(sw.tools.recordEdit.execute, edit);
    expect(res.ok).toBe(true);
    // The rescue is SURFACED on the tool result (#9 review round 4): `rescued: true` +
    // `healedSelector` carrying the ground-truth selector the fold adopted, so the model can
    // drop its paraphrase for subsequent calls.
    expect(data<{ rescued: boolean; healedSelector?: string }>(res)).toMatchObject({
      rescued: true,
      healedSelector: '#cta',
    });

    expect(sw.store.current.edits).toHaveLength(1);
    const recorded = sw.store.current.edits[0];
    // Ground truth folded in — and the fold HEALS the paraphrased selector to the event's own
    // (fold-mutations.ts: the page's record beats the model's restatement, strategy included).
    expect(recorded?.classes).toEqual([{ name: 'btn-primary', op: 'add' }]);
    expect(recorded?.selector).toEqual({ value: '#cta', strategy: 'id', fragile: false });
    // The rescue drain CONSUMED the group — turn end finds nothing to duplicate into an
    // "Auto-recorded" second edit for the one visual change.
    expect(sw.pending.peekGroups(TAB_ID)).toEqual([]);
    sw.finalizeTurn();
    expect(sw.store.current.edits).toHaveLength(1);
    expect(sw.toPanel.filter((m) => m.type === 'edit-recorded')).toHaveLength(1);
  });

  it('rescue gate: recordEdit for an event-less element does NOT steal an unrelated buffered group', async () => {
    const sw = makeSw();
    // One buffered group for '#nav' — the model's recordEdit targets '#cta', which shares NO
    // substring with it, so the gated rescue refuses: the drain returns empty and the model's
    // Edit stands untouched.
    sw.pending.append(
      TAB_ID,
      recorderEventOf('addClass', '#nav', {
        classChange: { name: 'sticky', op: 'add' },
        before: '',
        after: 'sticky',
      }),
    );
    const edit: Edit = {
      intent: 'Brand the CTA',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    const res = await runTool(sw.tools.recordEdit.execute, edit);
    expect(res.ok).toBe(true);
    expect(data<{ edits: number; spillover: number; rescued: boolean }>(res)).toEqual({
      edits: 1,
      spillover: 0,
      rescued: false, // the implausible miss drained nothing — no rescue, no healed selector
    });

    expect(sw.store.current.edits[0]).toEqual(edit);
    expect(sw.pending.peekGroups(TAB_ID)).toHaveLength(1);

    // Turn end then records the real group truthfully as its OWN auto-recorded edit.
    sw.finalizeTurn();
    expect(sw.store.current.edits).toHaveLength(2);
    const auto = sw.store.current.edits[1];
    expect(auto?.intent).toBe('Auto-recorded agent edit (no recordEdit call)');
    expect(auto?.selector.value).toBe('#nav');
    expect(auto?.classes).toEqual([{ name: 'sticky', op: 'add' }]);
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

  it('turn-end auto-finalize records one folded Edit per leftover group (splitting structural spillover), then wipes', () => {
    const { store, toPanel, persisted, pending, finalizeTurn } = makeSw();
    // The model mutated two elements but never called recordEdit for either; '#cta' got TWO
    // structural ops on top of an attr + class change.
    pending.append(
      TAB_ID,
      recorderEventOf('setAttr', '#cta', {
        attrChange: { name: 'data-variant', before: null, after: 'brand' },
        ts: 1,
      }),
    );
    pending.append(
      TAB_ID,
      recorderEventOf('addClass', '#cta', {
        classChange: { name: 'btn-primary', op: 'add' },
        before: '',
        after: 'btn-primary',
        ts: 2,
      }),
    );
    pending.append(
      TAB_ID,
      recorderEventOf('insertNode', '#cta', {
        structural: { op: 'insert', html: '<span class="badge">1</span>', position: 'beforeend' },
        ts: 3,
      }),
    );
    pending.append(
      TAB_ID,
      recorderEventOf('insertNode', '#cta', {
        structural: { op: 'insert', html: '<span class="badge">2</span>', position: 'beforeend' },
        ts: 4,
      }),
    );
    pending.append(
      TAB_ID,
      recorderEventOf('setStyle', '#nav', {
        styleChanges: [{ prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(9, 9, 9)' }],
        ts: 5,
      }),
    );

    finalizeTurn();

    // Three edits: the '#cta' fold (attr + class + FIRST structural op), its spillover (the
    // SECOND op), and the '#nav' fold.
    expect(store.current.edits).toHaveLength(3);
    const [cta, ctaSpill, nav] = store.current.edits;
    expect(cta?.intent).toBe('Auto-recorded agent edit (no recordEdit call)');
    expect(cta?.selector.value).toBe('#cta');
    expect(cta?.attrs).toEqual([{ name: 'data-variant', before: null, after: 'brand' }]);
    expect(cta?.classes).toEqual([{ name: 'btn-primary', op: 'add' }]);
    expect(cta?.structural).toEqual({
      op: 'insert',
      html: '<span class="badge">1</span>',
      position: 'beforeend',
    });
    expect(ctaSpill?.intent).toBe('Auto-recorded structural edit (additional op on same selector)');
    expect(ctaSpill?.selector.value).toBe('#cta');
    expect(ctaSpill?.structural).toEqual({
      op: 'insert',
      html: '<span class="badge">2</span>',
      position: 'beforeend',
    });
    expect(nav?.intent).toBe('Auto-recorded agent edit (no recordEdit call)');
    expect(nav?.selector.value).toBe('#nav');
    expect(nav?.changes).toEqual([
      { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(9, 9, 9)' },
    ]);
    // Streamed + persisted exactly like model-recorded edits; buffer empty; changeset valid.
    expect(toPanel.filter((m) => m.type === 'edit-recorded')).toHaveLength(3);
    expect(persisted.at(-1)?.edits).toHaveLength(3);
    expect(pending.peekGroups(TAB_ID)).toEqual([]);
    expect(Changeset.safeParse(store.current).success).toBe(true);
  });

  it('a reverted mutation never folds: mutate -> undo (recorder-revert) -> turn-end finalize records zero edits', () => {
    const { emitted, exec } = driveMutation('<button id="cta">Buy</button>');
    const sw = makeSw();
    const applied = exec({ type: 'setStyle', selector: '#cta', props: { color: 'rgb(1, 2, 3)' } });
    expect(applied.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const mutation = emitted[0];
    if (mutation?.type !== 'recorder-event') throw new Error('expected a recorder-event');
    // The SW push listener buffers the event per sender tab…
    sw.contentPush(mutation);
    expect(sw.pending.peekGroups(TAB_ID)).toHaveLength(1);

    // …and a successful undo's `recorder-revert` removes it: the change no longer exists on the
    // page, so it must never reach the durable changeset (background.ts:1264).
    const undone = exec({ type: 'undo' });
    expect(undone.ok).toBe(true);
    expect(emitted).toHaveLength(2);
    const revert = emitted[1];
    if (revert?.type !== 'recorder-revert') throw new Error('expected a recorder-revert');
    sw.contentPush(revert);
    expect(sw.pending.peekGroups(TAB_ID)).toEqual([]);

    sw.finalizeTurn();

    expect(sw.store.current.edits).toEqual([]);
    // Nothing recorded -> nothing persisted or streamed (neither recorder-* type relays either).
    expect(sw.persisted).toEqual([]);
    expect(sw.toPanel).toEqual([]);
  });

  it('discardUndo (drop WITHOUT reverting) leaves the buffered event truthful — it still folds', () => {
    const { emitted, exec } = driveMutation('<button id="cta">Buy</button>');
    const sw = makeSw();
    const applied = exec({ type: 'setStyle', selector: '#cta', props: { color: 'rgb(1, 2, 3)' } });
    expect(applied.ok).toBe(true);
    const mutation = emitted[0];
    if (mutation?.type !== 'recorder-event') throw new Error('expected a recorder-event');
    sw.contentPush(mutation);

    // The discardUndo escape pops the undo entry but does NOT revert the page (recorder.drop()
    // emits NOTHING) — the mutation is still live, so its event stays truthful in the buffer.
    const dropped = exec({ type: 'discardUndo' });
    expect(dropped.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(sw.pending.peekGroups(TAB_ID)).toHaveLength(1);

    sw.finalizeTurn();

    expect(sw.store.current.edits).toHaveLength(1);
    const edit = sw.store.current.edits[0];
    expect(edit?.intent).toBe('Auto-recorded agent edit (no recordEdit call)');
    expect(edit?.selector.value).toBe('#cta');
    // Folded from the genuine event's own typed deltas — the page's record, not a restatement.
    expect(mutation.event.styleChanges?.length).toBeGreaterThan(0);
    expect(edit?.changes).toEqual(mutation.event.styleChanges);
  });

  it('past the 200-event cap the oldest events drop and the auto-finalized intent surfaces the loss', () => {
    const { store, toPanel, pending, finalizeTurn } = makeSw();
    // 205 setStyle events on ONE selector: the 5 oldest fall off the per-tab cap (default 200).
    for (let i = 0; i < 205; i++) {
      pending.append(
        TAB_ID,
        recorderEventOf('setStyle', '#cta', {
          styleChanges: [
            { prop: 'color', before: `rgb(0, 0, ${i})`, after: `rgb(0, 0, ${i + 1})` },
          ],
          ts: i + 1,
        }),
      );
    }
    expect(pending.droppedCount(TAB_ID)).toBe(5);

    finalizeTurn();

    expect(store.current.edits).toHaveLength(1);
    const edit = store.current.edits[0];
    // The intent carries the drop count — a shipped changeset never silently omits mutations.
    expect(edit?.intent).toBe(
      'Auto-recorded agent edit (no recordEdit call) (+5 earlier events dropped at buffer cap)',
    );
    // The fold ran over the 200 SURVIVORS: first surviving before (event #5) -> last after (#204).
    expect(edit?.changes).toEqual([
      { prop: 'color', before: 'rgb(0, 0, 5)', after: 'rgb(0, 0, 205)' },
    ]);
    expect(toPanel).toContainEqual({ type: 'edit-recorded', edit });
    // clear() wipes the drop counter together with the buffer.
    expect(pending.droppedCount(TAB_ID)).toBe(0);
    expect(pending.peekGroups(TAB_ID)).toEqual([]);
  });

  it('a reload commit keeps the buffer + both changeset mirrors; an iframe commit never clears either', async () => {
    const sw = makeSw();
    const edit: Edit = {
      intent: 'Make the primary CTA blue',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(sw.tools.recordEdit.execute, edit);
    sw.pending.append(
      TAB_ID,
      recorderEventOf('addClass', '#cta', { classChange: { name: 'late', op: 'add' } }),
    );
    const pushesBefore = sw.toPanel.length;

    // background.ts:1288 — a RELOAD is an early return: same URL, so the recorded changeset and
    // the recorder buffer survive (docs/architecture/changeset.md).
    await sw.navClear({ frameId: 0, transitionType: 'reload', url: URL });
    expect(sw.persister.load()?.changeset.edits).toHaveLength(1);
    expect(sw.sessionMirror.changeset.edits).toHaveLength(1);
    expect(sw.pending.peekGroups(TAB_ID)).toHaveLength(1);
    expect(sw.toPanel).toHaveLength(pushesBefore); // nothing pushed

    // Iframe commits (frameId !== 0) never clear the tab's record either.
    await sw.navClear({ frameId: 2, transitionType: 'link', url: 'http://localhost:3000/embed' });
    expect(sw.persister.load()?.changeset.edits).toHaveLength(1);
    expect(sw.sessionMirror.changeset.edits).toHaveLength(1);
    expect(sw.pending.peekGroups(TAB_ID)).toHaveLength(1);
    expect(sw.toPanel).toHaveLength(pushesBefore);
  });

  it('nav-clear wipes the tab’s edits + buffer on a main-frame cross-URL commit but keeps the thread', async () => {
    const sw = makeSw();
    const edit: Edit = {
      intent: 'Make the primary CTA blue',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(sw.tools.recordEdit.execute, edit);
    sw.pending.append(
      TAB_ID,
      recorderEventOf('addClass', '#cta', { classChange: { name: 'late', op: 'add' } }),
    );
    expect(sw.persister.load()?.changeset.edits).toHaveLength(1);
    expect(sw.sessionMirror.changeset.edits).toHaveLength(1);

    // The wipe continuation is deferred in background.ts (sessionsReady.then + the round-4
    // race re-check) — navClear returns its promise so the test can await the settle.
    await sw.navClear({ frameId: 0, transitionType: 'link', url: 'http://localhost:3000/other' });

    // BOTH mirrors wiped (turn start falls back to the session mirror when the persister is
    // empty — re-seeding it EMPTY for the new URL is what stops the old edits resurrecting).
    expect(sw.persister.load()).toBeUndefined();
    expect(sw.sessionMirror.changeset.edits).toEqual([]);
    expect(sw.sessionMirror.changeset.url).toBe('http://localhost:3000/other');
    expect(sw.sessionMirror.changeset.sessionId).toBe(NAV_SESSION_ID);
    expect(sw.sessionMirror.changeset.sessionId).not.toBe(SESSION_ID);
    // The recorder buffer is gone too — but the conversation thread survives the navigation.
    expect(sw.pending.peekGroups(TAB_ID)).toEqual([]);
    expect(sw.sessionMirror.messages).toEqual(['user: make the CTA pop']);

    // The emptied record is pushed to the panel (tabId-stamped, background.ts:1299) so an open
    // Diff tab drops the dead page's edits NOW — the REAL panel fold adopts it wholesale.
    expect(sw.toPanel.at(-1)).toEqual({
      type: 'changeset',
      changeset: sw.sessionMirror.changeset,
      tabId: TAB_ID,
    });
    const folded = sw.toPanel.reduce<Changeset | null>((acc, m) => reduceChangeset(acc, m), null);
    expect(folded?.edits).toEqual([]);
    expect(folded?.url).toBe('http://localhost:3000/other');
  });

  it('turn-start URL guard: a persisted changeset from another URL is discarded (both mirrors re-seeded empty)', async () => {
    const sw = makeSw();
    const edit: Edit = {
      intent: 'Make the primary CTA blue',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(sw.tools.recordEdit.execute, edit);

    // Same-URL turn start: the guard does NOT overfire — the persister record rehydrates intact…
    sw.bootTurn(URL);
    expect(sw.store.current.edits).toHaveLength(1);
    expect(sw.store.current.url).toBe(URL);

    // …redo stack included: undo, re-boot on the same URL, and the redo survives the rehydrate.
    const undo = await runTool(sw.tools.undo.execute, {});
    expect(data<{ undone: boolean }>(undo).undone).toBe(true);
    sw.bootTurn(URL);
    expect(sw.store.current.edits).toEqual([]);
    expect(sw.store.canRedo).toBe(true);

    // The between-turns navigation race (background.ts:605): the tab committed a NEW URL while
    // the persister + mirror still hold the old page's record (the nav-clear wipe is async and
    // can lose the race). Turn start discards the stale record — BOTH mirrors re-seed EMPTY for
    // the tab's current URL, and the redo stack (which only references the old record's edits)
    // is dropped.
    sw.bootTurn('http://localhost:3000/other');
    expect(sw.store.current.edits).toEqual([]);
    expect(sw.store.current.url).toBe('http://localhost:3000/other');
    expect(sw.store.current.sessionId).toBe(BOOT_SESSION_ID);
    expect(sw.store.canRedo).toBe(false);
    expect(sw.persister.load()?.changeset.edits).toEqual([]);
    expect(sw.persister.load()?.changeset.url).toBe('http://localhost:3000/other');
    expect(sw.sessionMirror.changeset.edits).toEqual([]);
    expect(sw.sessionMirror.changeset.url).toBe('http://localhost:3000/other');
    // The wipe is persisted immediately, so neither mirror can resurrect the old page's edits.
    expect(sw.persisted.at(-1)?.edits).toEqual([]);
    expect(sw.persisted.at(-1)?.url).toBe('http://localhost:3000/other');
  });
});

describe('#9 review round 4: retract op / in-turn store / nav-clear race / eviction-safe URL guard', () => {
  it('a drained-then-reverted edit is retracted from the durable record (persister + mirror + panel push)', async () => {
    const { emitted, exec } = driveMutation('<button id="cta">Buy</button>');
    const sw = makeSw();
    const applied = exec({ type: 'setStyle', selector: '#cta', props: { color: 'rgb(1, 2, 3)' } });
    expect(applied.ok).toBe(true);
    const mutation = emitted[0];
    if (mutation?.type !== 'recorder-event') throw new Error('expected a recorder-event');
    sw.contentPush(mutation);

    // recordEdit drains the buffered event into the durable edit — the event leaves the buffer.
    const edit: Edit = {
      intent: 'Make the primary CTA colorful',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(sw.tools.recordEdit.execute, edit);
    expect(sw.persister.load()?.changeset.edits).toHaveLength(1);

    // BETWEEN turns (no in-flight turn): the op path alone must cover the retraction.
    sw.endTurn();
    // The user undoes the change: the revert's buffer remove MISSES (the event was drained),
    // so the phantom lives only in the durable record.
    const undone = exec({ type: 'undo' });
    expect(undone.ok).toBe(true);
    const revert = emitted[1];
    if (revert?.type !== 'recorder-revert') throw new Error('expected a recorder-revert');
    sw.contentPush(revert);
    await sw.retraction;

    // The retract op stripped the edit's only family to empty ⇒ the edit is REMOVED from both
    // mirrors, and the tab-stamped push carries the emptied record to the panel.
    expect(sw.persister.load()?.changeset.edits).toEqual([]);
    expect(sw.sessionMirror.changeset.edits).toEqual([]);
    expect(sw.toPanel.at(-1)).toEqual({
      type: 'changeset',
      changeset: sw.sessionMirror.changeset,
      tabId: TAB_ID,
    });
    const folded = sw.toPanel.reduce<Changeset | null>((acc, m) => reduceChangeset(acc, m), null);
    expect(folded?.edits).toEqual([]);
  });

  it('mid-turn revert strips the turn’s in-memory store, so the next recordEdit can’t resurrect it', async () => {
    const { emitted, exec } = driveMutation('<button id="cta">Buy</button><nav id="nav">n</nav>');
    const sw = makeSw(); // a turn is in flight (bootTurn)
    expect(exec({ type: 'setStyle', selector: '#cta', props: { color: 'rgb(1, 2, 3)' } }).ok).toBe(
      true,
    );
    const e1 = emitted[0];
    if (e1?.type !== 'recorder-event') throw new Error('expected a recorder-event');
    sw.contentPush(e1);
    const edit1: Edit = {
      intent: 'Color the CTA',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(sw.tools.recordEdit.execute, edit1);
    expect(sw.store.current.edits).toHaveLength(1);

    // Mid-turn revert of the CTA change: the buffer remove misses (drained above), so BOTH the
    // durable record and the turn's live store hold the phantom.
    const undone = exec({ type: 'undo' });
    expect(undone.ok).toBe(true);
    const revert = emitted[1];
    if (revert?.type !== 'recorder-revert') throw new Error('expected a recorder-revert');
    sw.contentPush(revert);
    await sw.retraction;
    // The op retracted the durable record AND the in-turn strip caught the live store.
    expect(sw.persister.load()?.changeset.edits).toEqual([]);
    expect(sw.store.current.edits).toEqual([]);

    // The turn records another edit: its persist must NOT resurrect the retracted one — the
    // pre-round-4 failure mode (the turn's store still held the phantom and persisted it back).
    expect(exec({ type: 'setStyle', selector: '#nav', props: { color: 'rgb(4, 5, 6)' } }).ok).toBe(
      true,
    );
    const e2 = emitted[2];
    if (e2?.type !== 'recorder-event') throw new Error('expected a recorder-event');
    sw.contentPush(e2);
    const edit2: Edit = {
      intent: 'Color the nav',
      selector: { value: '#nav', strategy: 'id', fragile: false },
      changes: [],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(sw.tools.recordEdit.execute, edit2);
    expect(sw.persisted.at(-1)?.edits).toHaveLength(1);
    expect(sw.persisted.at(-1)?.edits[0]?.selector.value).toBe('#nav');
    expect(sw.persister.load()?.changeset.edits).toHaveLength(1);
    expect(sw.sessionMirror.changeset.edits[0]?.selector.value).toBe('#nav');
  });

  it('partial revert of a merged fold keeps the edit with the prop restored to the first value', async () => {
    const { emitted, exec } = driveMutation('<button id="cta">Buy</button>');
    const sw = makeSw();
    // Two stacked setStyles on ONE prop fold into ONE edit (first before -> last after).
    expect(
      exec({ type: 'setStyle', selector: '#cta', props: { color: 'rgb(200, 0, 0)' } }).ok,
    ).toBe(true);
    expect(
      exec({ type: 'setStyle', selector: '#cta', props: { color: 'rgb(0, 0, 200)' } }).ok,
    ).toBe(true);
    const [red, blue] = emitted;
    if (red?.type !== 'recorder-event' || blue?.type !== 'recorder-event')
      throw new Error('expected recorder-events');
    sw.contentPush(red);
    sw.contentPush(blue);
    const edit: Edit = {
      intent: 'Recolor the CTA',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(sw.tools.recordEdit.execute, edit);
    expect(sw.store.current.edits).toHaveLength(1);
    expect(sw.store.current.edits[0]?.changes[0]?.after).toBe(blue.event.styleChanges?.[0]?.after);

    // Revert ONLY the second mutation (undo unwinds LIFO — the blue one): the edit SURVIVES —
    // the red change is still live on the page — with the prop's `after` restored to the red
    // readback and `before` untouched.
    const undone = exec({ type: 'undo' });
    expect(undone.ok).toBe(true);
    const revert = emitted[2];
    if (revert?.type !== 'recorder-revert') throw new Error('expected a recorder-revert');
    expect(revert.event).toEqual(blue.event);
    sw.contentPush(revert);
    await sw.retraction;

    const surviving = sw.persister.load()?.changeset.edits;
    expect(surviving).toHaveLength(1);
    expect(surviving?.[0]?.changes).toEqual([
      {
        prop: 'color',
        before: red.event.styleChanges?.[0]?.before,
        after: red.event.styleChanges?.[0]?.after,
      },
    ]);
    // The in-turn store + the session mirror agree with the persister.
    expect(sw.store.current.edits[0]?.changes[0]?.after).toBe(red.event.styleChanges?.[0]?.after);
    expect(sw.sessionMirror.changeset.edits).toHaveLength(1);
  });

  it("reverting a folded setAttr('class') strips the classes family but keeps the others", async () => {
    const sw = makeSw();
    // One edit folds a color change AND a whole-class-list rewrite (setAttr('class') feeds the
    // classes family — the fold's window set-diff — never the attrs family).
    sw.contentPush({
      type: 'recorder-event',
      event: recorderEventOf('setStyle', '#cta', {
        styleChanges: [{ prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(9, 9, 9)' }],
        ts: 1,
      }),
    });
    sw.contentPush({
      type: 'recorder-event',
      event: recorderEventOf('setAttr', '#cta', {
        attrChange: { name: 'class', before: null, after: 'btn-primary wide' },
        ts: 2,
      }),
    });
    const edit: Edit = {
      intent: 'Brand + recolor the CTA',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(sw.tools.recordEdit.execute, edit);
    const foldedEdit = sw.store.current.edits[0];
    expect(foldedEdit?.changes).toEqual([
      { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(9, 9, 9)' },
    ]);
    expect(foldedEdit?.classes).toEqual([
      { name: 'btn-primary', op: 'add' },
      { name: 'wide', op: 'add' },
    ]);
    expect(foldedEdit?.attrs).toEqual([]);

    // Revert the setAttr('class') (the recorder-revert carries the original event): its
    // contribution — the classes it wrote — leaves the edit; the color family stays.
    sw.contentPush({
      type: 'recorder-revert',
      event: recorderEventOf('setAttr', '#cta', {
        attrChange: { name: 'class', before: null, after: 'btn-primary wide' },
        ts: 2,
      }),
    });
    await sw.retraction;

    const surviving = sw.persister.load()?.changeset.edits;
    expect(surviving).toHaveLength(1);
    expect(surviving?.[0]?.classes).toEqual([]);
    expect(surviving?.[0]?.changes).toEqual([
      { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(9, 9, 9)' },
    ]);
    expect(sw.store.current.edits[0]?.classes).toEqual([]);
  });

  it('nav-clear race: the deferred wipe no-ops when a racing turn already re-seeded the persister', async () => {
    const sw = makeSw();
    const edit: Edit = {
      intent: 'Make the primary CTA blue',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(sw.tools.recordEdit.execute, edit);
    expect(sw.persister.load()?.changeset.edits).toHaveLength(1);

    // The commit stamps the new URL synchronously; the wipe continuation is DEFERRED
    // (background.ts's sessionsReady.then). A turn starts inside the deferral window: its URL
    // guard sees the fresh stamp and re-seeds BOTH mirrors EMPTY for the new URL.
    const continuation = sw.navClear({
      frameId: 0,
      transitionType: 'link',
      url: 'http://localhost:3000/new',
    });
    sw.bootTurn('http://localhost:3000/new');
    expect(sw.persister.load()?.changeset.url).toBe('http://localhost:3000/new');
    const pushesBefore = sw.toPanel.length;
    await continuation;

    // The continuation's re-check saw the persister already carrying the new URL and skipped
    // the clear + reseed + push: the racing turn's record (its sessionId included) survives.
    expect(sw.persister.load()?.changeset.url).toBe('http://localhost:3000/new');
    expect(sw.persister.load()?.changeset.sessionId).toBe(BOOT_SESSION_ID);
    expect(sw.sessionMirror.changeset.sessionId).toBe(BOOT_SESSION_ID);
    expect(sw.toPanel).toHaveLength(pushesBefore); // no stale wipe push
  });

  it('the persisted committedUrl anchors the URL guard across an SW eviction (same-document tab.url change keeps the record)', async () => {
    const sw = makeSw();
    const edit: Edit = {
      intent: 'Make the primary CTA blue',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(sw.tools.recordEdit.execute, edit);
    expect(sw.store.current.edits).toHaveLength(1);

    // The committed main-frame URL was persisted to chrome.storage.session by the onCommitted
    // listener (seeded here — the fake stands in for the storage write), then the SW was
    // evicted: its in-memory stamps are gone, the storage-backed ones survive.
    sw.persistedCommitted.set(TAB_ID, URL);
    sw.evict();

    // A same-document navigation (hash change / pushState) fires NO commit: the live tab.url
    // gains a hash but the document — and the durable record — must survive. Pre-round-4 the
    // woken SW fell back to the live tab.url and false-wiped the record on the mismatch.
    sw.bootTurn(`${URL}#pricing`);
    expect(sw.store.current.edits).toHaveLength(1);
    expect(sw.store.current.url).toBe(URL);
    expect(sw.persister.load()?.changeset.edits).toHaveLength(1);
    expect(sw.sessionMirror.changeset.edits).toHaveLength(1);
  });
});

describe('#9 review round 5: a retract preserves the redo tail (preserveRedo end-to-end)', () => {
  it('recordEdit ×2 → session undo (tail populated) → DOM-undo retract of the OTHER edit → session redo still re-applies', async () => {
    const { emitted, exec } = driveMutation('<button id="cta">Buy</button><nav id="nav">n</nav>');
    const sw = makeSw(); // a turn is in flight (bootTurn)
    expect(exec({ type: 'setStyle', selector: '#cta', props: { color: 'rgb(1, 2, 3)' } }).ok).toBe(
      true,
    );
    expect(exec({ type: 'setStyle', selector: '#nav', props: { color: 'rgb(4, 5, 6)' } }).ok).toBe(
      true,
    );
    const [eCta, eNav] = emitted;
    if (eCta?.type !== 'recorder-event' || eNav?.type !== 'recorder-event')
      throw new Error('expected recorder-events');
    sw.contentPush(eCta);
    sw.contentPush(eNav);

    const mk = (intent: string, selectorValue: string): Edit => ({
      intent,
      selector: { value: selectorValue, strategy: 'id', fragile: false },
      changes: [],
      attrs: [],
      classes: [],
      frameworkHints: [],
    });
    await runTool(sw.tools.recordEdit.execute, mk('Color the CTA', '#cta'));
    await runTool(sw.tools.recordEdit.execute, mk('Color the nav', '#nav'));
    expect(sw.store.current.edits).toHaveLength(2);

    // Session undo pops the nav edit onto the redo stack — the tail this test protects.
    const undone = await runTool(sw.tools.undo.execute, {});
    expect(data<{ undone: boolean }>(undone).undone).toBe(true);
    expect(sw.store.current.edits).toHaveLength(1);
    expect(sw.store.canRedo).toBe(true);

    // DOM-undo BOTH mutations (the recorder unwinds LIFO: nav first, then the CTA). The nav
    // revert no-ops — its edit sits on the redo stack, not in the record (no consistent edit);
    // the CTA revert retracts the remaining edit from BOTH the durable record and the turn's
    // in-memory store. Pre-round-5 both removeAt calls wiped the redo tail with them.
    expect(exec({ type: 'undo' }).ok).toBe(true);
    expect(exec({ type: 'undo' }).ok).toBe(true);
    const [navRevert, ctaRevert] = emitted.slice(2);
    if (navRevert?.type !== 'recorder-revert' || ctaRevert?.type !== 'recorder-revert')
      throw new Error('expected recorder-reverts');
    expect(navRevert.event.selector.value).toBe('#nav');
    expect(ctaRevert.event.selector.value).toBe('#cta');
    sw.contentPush(navRevert);
    await sw.retraction;
    sw.contentPush(ctaRevert);
    await sw.retraction;

    // The OTHER edit was retracted; the redo tail SURVIVED in the live store AND the persister.
    expect(sw.store.current.edits).toEqual([]);
    expect(sw.store.canRedo).toBe(true);
    expect(sw.persister.load()?.changeset.edits).toEqual([]);
    expect(sw.persister.load()?.redoStack).toHaveLength(1);

    // Session redo still re-applies the undone nav edit.
    const redone = await runTool(sw.tools.redo.execute, {});
    expect(data<{ redone: boolean }>(redone).redone).toBe(true);
    expect(sw.store.current.edits).toHaveLength(1);
    expect(sw.store.current.edits[0]?.selector.value).toBe('#nav');
    expect(sw.persister.load()?.changeset.edits).toHaveLength(1);
    expect(sw.persister.load()?.redoStack).toEqual([]);
    expect(sw.sessionMirror.changeset.edits[0]?.selector.value).toBe('#nav');
  });
});
