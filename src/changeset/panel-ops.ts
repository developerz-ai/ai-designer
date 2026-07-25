// Panel-driven changeset curation (slice 10) — the SW-side core behind the Diff tab's
// changeset-get / undo / redo / clear / remove-edit RPCs (src/shared/messages.ts), plus the
// round-4 `retract` op the background recorder-revert path drives (#9: a late revert whose
// event already left the pending buffer retracts its durable record through the SAME
// machinery). It operates on the SAME per-tab, redo-capable ChangesetStore the agent's
// recordEdit/undo/redo tools drive (src/agent/tools/session.ts), persisted to
// chrome.storage.session. It curates the DURABLE, shippable record ONLY — it never reverts
// the live page (edits are ephemeral; #10).
//
// Chrome-free by construction: persistence + the SessionStore mirror are injected as ports, so a
// unit test passes an in-memory fake and this stays importable in jsdom/node with no `chrome.*`.
// background.ts wires the ports to `createSessionChangesetPersister(tabId)` + `sessions.setChangeset`
// and pushes the resulting `changeset` to the panel; the turn-in-flight guard lives there (a panel
// op must not clobber a running turn's own store), so these functions assume it is safe to mutate.

import type { Changeset, ChangesetState } from '@/shared/changeset';
import type { MutationEvent } from '@/shared/messages';
import { findLastMatchingEditIndex, stripEventFromEdit } from './revert-match';
import { ChangesetStore } from './store';

/** One curation op from the Diff tab — or, for `retract`, from the background recorder-revert
 *  path (#9 round-4). `remove` carries the 0-based edit index; `retract` carries the reverted
 *  recorder event and is matched + stripped internally against THIS op's load, so the match
 *  can never go stale between two loads (the old background path's double-load TOCTOU). */
export type ChangesetOp =
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'remove'; readonly index: number }
  | { readonly kind: 'retract'; readonly event: MutationEvent };

/** The ports the curation core needs, injected so it stays chrome-free + testable. */
export interface ChangesetPorts {
  /** Load the tab's persisted state (changeset + redo stack), or `undefined` when none exists. */
  readonly load: () => Promise<ChangesetState | undefined>;
  /** Persist the mutated state (→ chrome.storage.session). `await`ed, so a sync or async port both
   *  work — matches `SessionChangesetPersister.save` (`PersistChangesetState`). */
  readonly save: (state: ChangesetState) => void | Promise<void>;
  /** Mirror the current changeset onto the SessionStore so Ship/report reads see it. Best-effort. */
  readonly mirror: (changeset: Changeset) => Promise<void>;
  /** Re-checked once AFTER `load` resolves, before any mutation: return `false` to abort the op as
   *  `busy` (the pre-load guard alone is check-then-act — a turn starting inside the load window
   *  would otherwise persist over this op's result; #141 review). */
  readonly guard?: () => boolean;
}

/** The Diff tab's view of the changeset: the record plus undo/redo availability. `changeset` is
 *  `null` when the tab has no session/edits yet. */
export interface ChangesetView {
  readonly changeset: Changeset | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/** `applyChangesetOp`'s result: the post-op view, or the PRE-op view with `busy: true` when the
 *  post-load `guard` aborted the mutation (nothing was persisted or mirrored). */
export type ChangesetOpResult = ChangesetView & { readonly busy?: true };

const EMPTY: ChangesetView = { changeset: null, canUndo: false, canRedo: false };

function view(store: ChangesetStore): ChangesetView {
  return { changeset: store.current, canUndo: store.canUndo, canRedo: store.canRedo };
}

/** Read the tab's current changeset + undo/redo availability without mutating anything
 *  (`changeset-get`). Returns the empty view when the tab has no persisted changeset. */
export async function readChangeset(load: ChangesetPorts['load']): Promise<ChangesetView> {
  const state = await load();
  return state ? view(ChangesetStore.fromState(state)) : EMPTY;
}

/** Apply one curation op to the tab's changeset, persist the new state, mirror it to the
 *  SessionStore, and return the resulting view. A no-op op (undo with an empty changeset, remove out
 *  of range) still persists idempotently. Returns the empty view when the tab has no changeset — the
 *  op has nothing to act on. A `guard` returning false after the load aborts before any mutation and
 *  echoes the pre-op view with `busy: true`. A `retract` whose event matches NO durable edit is a
 *  true no-op — the pre-op view, with NOTHING persisted or mirrored (the record may have been
 *  curated or nav-cleared since the event drained, which is not an error). Never reverts the live
 *  page; the durable record only. */
export async function applyChangesetOp(
  ports: ChangesetPorts,
  op: ChangesetOp,
): Promise<ChangesetOpResult> {
  const state = await ports.load();
  if (!state) return ports.guard && !ports.guard() ? { ...EMPTY, busy: true } : EMPTY;
  const store = ChangesetStore.fromState(state);
  if (ports.guard && !ports.guard()) return { ...view(store), busy: true };
  switch (op.kind) {
    case 'undo':
      store.undo();
      break;
    case 'redo':
      store.redo();
      break;
    case 'clear':
      store.clear();
      break;
    case 'remove':
      store.removeAt(op.index);
      break;
    case 'retract': {
      // Surgical late-revert retraction (#9 round-4): match + strip against the edits from THIS
      // load — one load, so the index can never go stale before the mutation lands.
      const index = findLastMatchingEditIndex(store.current.edits, op.event);
      if (index === -1) return view(store); // no match ⇒ no-op: nothing persisted/mirrored
      const edit = store.current.edits[index];
      const stripped = edit ? stripEventFromEdit(edit, op.event) : null;
      if (stripped === null)
        store.removeAt(index); // nothing recorded remains ⇒ the edit dies
      else store.replaceAt(index, stripped);
      break;
    }
  }
  await ports.save(store.snapshot());
  await ports.mirror(store.current);
  return view(store);
}
