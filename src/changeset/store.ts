// The live changeset for one design session — the durable record of accepted edits that the
// `recordEdit` / `undo` / `redo` agent tools (src/agent/tools/session.ts) drive and the Ship
// handoff (slice 07) reads. Minimal by design: an in-memory changeset plus a linear undo/redo
// history. Durable persistence + the report pass land in slice 07 (PR12); here the SW session
// store (src/agent/session.ts) already owns `chrome.storage.session`, so this stays chrome-free
// and unit-testable — the caller seeds a store from a rehydrated changeset and persists `current`
// back after each mutation.
//
// SW-ONLY by usage, chrome-free by construction: no `chrome.*`, no DOM. One store backs one tab's
// session. The changeset value is treated immutably (structural sharing via `addEdit`), so
// `current` is a snapshot safe to persist or stream to the panel without later mutations leaking.

import { addEdit, type Changeset, type Edit } from '@/shared/changeset';

/**
 * A single session's changeset with a linear undo/redo history. `record` appends an edit and forks
 * history (drops any redo tail); `undo` moves the most recent edit onto the redo stack; `redo`
 * re-applies it. Edits are the shippable record — reversing one removes it from what Ship hands off.
 */
export class ChangesetStore {
  private changeset: Changeset;
  // Edits popped by `undo`, newest last — re-applied LIFO by `redo`, cleared on a fresh `record`.
  private readonly redoStack: Edit[] = [];

  constructor(changeset: Changeset) {
    this.changeset = changeset;
  }

  /** The current changeset snapshot — persist this and/or stream it to the panel. */
  get current(): Changeset {
    return this.changeset;
  }

  /** Number of edits currently in the changeset. */
  get size(): number {
    return this.changeset.edits.length;
  }

  /** Whether there is an edit to undo. */
  get canUndo(): boolean {
    return this.changeset.edits.length > 0;
  }

  /** Whether there is an undone edit to redo. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Append an edit to the changeset. A new edit forks history, so the redo stack is cleared. */
  record(edit: Edit): Edit {
    this.changeset = addEdit(this.changeset, edit);
    this.redoStack.length = 0;
    return edit;
  }

  /** Remove the most recent edit and push it onto the redo stack. Returns the undone edit, or
   *  `undefined` when the changeset is empty. */
  undo(): Edit | undefined {
    const { edits } = this.changeset;
    const last = edits[edits.length - 1];
    if (!last) return undefined;
    this.changeset = { ...this.changeset, edits: edits.slice(0, -1) };
    this.redoStack.push(last);
    return last;
  }

  /** Re-apply the most recently undone edit. Returns the redone edit, or `undefined` when there is
   *  nothing to redo. */
  redo(): Edit | undefined {
    const edit = this.redoStack.pop();
    if (!edit) return undefined;
    this.changeset = addEdit(this.changeset, edit);
    return edit;
  }
}
