// Panel-driven changeset curation (slice 10) — the SW-side core behind the Diff tab's
// changeset-get / undo / redo / clear / remove-edit RPCs (src/shared/messages.ts). It operates on
// the SAME per-tab, redo-capable ChangesetStore the agent's recordEdit/undo/redo tools drive
// (src/agent/tools/session.ts), persisted to chrome.storage.session. It curates the DURABLE,
// shippable record ONLY — it never reverts the live page (edits are ephemeral; #10).
//
// Chrome-free by construction: persistence + the SessionStore mirror are injected as ports, so a
// unit test passes an in-memory fake and this stays importable in jsdom/node with no `chrome.*`.
// background.ts wires the ports to `createSessionChangesetPersister(tabId)` + `sessions.setChangeset`
// and pushes the resulting `changeset` to the panel; the turn-in-flight guard lives there (a panel
// op must not clobber a running turn's own store), so these functions assume it is safe to mutate.

import type { Changeset, ChangesetState } from '@/shared/changeset';
import { ChangesetStore } from './store';

/** One curation op from the Diff tab. `remove` carries the 0-based edit index. */
export type ChangesetOp =
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'remove'; readonly index: number };

/** The ports the curation core needs, injected so it stays chrome-free + testable. */
export interface ChangesetPorts {
  /** Load the tab's persisted state (changeset + redo stack), or `undefined` when none exists. */
  readonly load: () => Promise<ChangesetState | undefined>;
  /** Persist the mutated state (→ chrome.storage.session). `await`ed, so a sync or async port both
   *  work — matches `SessionChangesetPersister.save` (`PersistChangesetState`). */
  readonly save: (state: ChangesetState) => void | Promise<void>;
  /** Mirror the current changeset onto the SessionStore so Ship/report reads see it. Best-effort. */
  readonly mirror: (changeset: Changeset) => Promise<void>;
}

/** The Diff tab's view of the changeset: the record plus undo/redo availability. `changeset` is
 *  `null` when the tab has no session/edits yet. */
export interface ChangesetView {
  readonly changeset: Changeset | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

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
 *  op has nothing to act on. Never reverts the live page; the durable record only. */
export async function applyChangesetOp(
  ports: ChangesetPorts,
  op: ChangesetOp,
): Promise<ChangesetView> {
  const state = await ports.load();
  if (!state) return EMPTY;
  const store = ChangesetStore.fromState(state);
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
  }
  await ports.save(store.snapshot());
  await ports.mirror(store.current);
  return view(store);
}
