// The running turn's changeset: the in-memory store plus the guarded write-back to both mirrors
// (the redo-capable persister record and the SessionStore copy Ship reads).
//
// Three rules live here, so background.ts holds none of them:
//   • PERSIST ONLY THE CURRENT DOCUMENT. A write is refused when the store's URL is not the tab's
//     committed (document) URL — after a page/user navigation the store still holds the old
//     document's edits, and writing them back would resurrect what nav-clear wiped (#148 item 2).
//   • REBASE ON THE AGENT'S OWN NAVIGATION. When the agent navigates the turn's tab (a nav driver,
//     or a click/submit that commits a new document), the turn keeps running — so its store moves
//     to the new document: old-document edits are dropped (they died with that document, and
//     nav-clear wipes them from both mirrors), the conversation id is kept (#168 L6), and every
//     edit recorded from here on persists. Without the rebase, the store's stale URL made the
//     guard above refuse every later write of the turn: `recordEdit` answered ok, nothing was
//     persisted, and Ship said "Nothing to ship".
//   • NOTHING AFTER CLOSE. A closed tab's records were removed (#310); a turn still unwinding on it
//     must not write `changeset:<tabId>` back into existence.
//
// The store itself is SWAPPED on rebase (`ChangesetStore` has no way to change its URL), so
// consumers read `.store` at use time rather than holding the instance.

import { ChangesetStore } from '@/changeset/store';
import { type Changeset, type ChangesetState, emptyChangeset } from '@/shared/changeset';

export interface TurnChangesetDeps {
  /** The tab's committed (document) URL right now. */
  readonly committedUrl: () => Promise<string>;
  /** Write the redo-capable record (`changeset:<tabId>`). */
  readonly save: (state: ChangesetState) => Promise<void> | void;
  /** Mirror the changeset into the SessionStore (what Ship / report read). */
  readonly mirror: (changeset: Changeset) => Promise<unknown>;
  /** ISO timestamp for a rebased record's `createdAt`. */
  readonly now?: () => string;
}

export class TurnChangeset {
  private current: ChangesetStore;
  private closed = false;

  constructor(
    store: ChangesetStore,
    private readonly deps: TurnChangesetDeps,
  ) {
    this.current = store;
  }

  /** The live store. Read at use time: a rebase replaces it. */
  get store(): ChangesetStore {
    return this.current;
  }

  /** Whether the tab closed under the turn (every later persist is refused). */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Write the store to both mirrors — unless the tab closed, or the store is not for the tab's
   *  current document. Everything is read AFTER the URL await, so a rebase that lands during it
   *  writes the rebased store, never the stale one. */
  async persist(): Promise<void> {
    if (this.closed) return;
    const committed = await this.deps.committedUrl();
    if (this.closed || this.current.current.url !== committed) return;
    const source = this.current;
    const state = source.snapshot();
    await this.deps.save(state);
    // Re-check the document before MIRRORING: a navigation that committed during the save has
    // had nav-clear reseed Ship's mirror for the new document — republishing this snapshot over
    // it would put the dead page's edits back in front of Ship. (Same if the store was rebased.)
    if (this.closed || this.current !== source) return;
    if ((await this.deps.committedUrl()) !== state.changeset.url) return;
    if (this.closed || this.current !== source) return;
    await this.deps.mirror(state.changeset);
  }

  /** Move the turn onto a new document (`url`). A no-op for the same URL (a reload keeps the
   *  record) or after close. Returns whether it rebased. */
  rebase(url: string): boolean {
    if (this.closed || this.current.current.url === url) return false;
    const createdAt = (this.deps.now ?? (() => new Date().toISOString()))();
    this.current = new ChangesetStore(
      emptyChangeset(url, createdAt, this.current.current.sessionId),
    );
    return true;
  }

  /** The tab closed: refuse every later write. */
  close(): void {
    this.closed = true;
  }
}
