// The live changeset for one design session — the durable record of accepted edits that the
// `recordEdit` / `undo` / `redo` agent tools (src/agent/tools/session.ts) drive and the Ship
// handoff (slice 07) reads. An in-memory changeset plus a linear undo/redo history, made
// serializable so its FULL state (edits + redo stack) round-trips through `chrome.storage.session`:
// an SW eviction mid-session (docs/architecture/mv3-worlds.md "Service-worker ephemerality") wakes
// with undo/redo intact, not just the current edits.
//
// The store core stays chrome-free by construction: persistence is an injected port
// ({@link PersistChangesetState}), so unit tests pass a fake (or nothing) and never touch `chrome.*`.
// The one place `chrome.storage.session` is bound — {@link createSessionChangesetPersister} — reads
// it lazily, so importing this module in jsdom is safe. This owns the *editable* changeset + history
// (the diff view's source of truth); `src/agent/session.ts` owns the turn thread + a changeset
// snapshot for resume context.
//
// SW-ONLY by usage. One store backs one tab's session. The changeset value is treated immutably
// (structural sharing via `addEdit`), so `current` / `snapshot()` are safe to persist or stream to
// the panel without later mutations leaking.

import { addEdit, type Changeset, ChangesetState, type Edit } from '@/shared/changeset';

/** Persist the store's full state after each mutation. Injected so the store stays chrome-free and
 *  unit-testable; the SW binds it to `chrome.storage.session` via {@link createSessionChangesetPersister}.
 *  Called best-effort (fire-and-forget) from the synchronous mutators — a rejected write is swallowed
 *  so a transient storage error never corrupts an in-flight turn. */
export type PersistChangesetState = (state: ChangesetState) => void | Promise<void>;

export interface ChangesetStoreOptions {
  /** Undone edits available for `redo`, newest last — supplied when rehydrating a persisted state so
   *  undo/redo survives an SW eviction. Copied defensively; the caller's array is never mutated. */
  readonly redoStack?: readonly Edit[];
  /** Called after every mutation with the new full state. Best-effort; see {@link PersistChangesetState}. */
  readonly persist?: PersistChangesetState;
}

/**
 * A single session's changeset with a linear undo/redo history. `record` appends an edit and forks
 * history (drops any redo tail); `undo` moves the most recent edit onto the redo stack; `redo`
 * re-applies it. Edits are the shippable record — reversing one removes it from what Ship hands off.
 * Every mutation calls the injected `persist` port with the new {@link snapshot} so the full state
 * (edits + redo stack) mirrors to `chrome.storage.session`.
 */
export class ChangesetStore {
  private changeset: Changeset;
  // Edits popped by `undo`, newest last — re-applied LIFO by `redo`, cleared on a fresh `record`.
  private readonly redoStack: Edit[];
  private readonly persist?: PersistChangesetState;

  constructor(changeset: Changeset, options: ChangesetStoreOptions = {}) {
    this.changeset = changeset;
    this.redoStack = options.redoStack ? [...options.redoStack] : [];
    this.persist = options.persist;
  }

  /** Rehydrate a store from a persisted {@link ChangesetState} (both the changeset and the redo
   *  stack), so a woken SW resumes undo/redo where it left off. */
  static fromState(state: ChangesetState, options: Omit<ChangesetStoreOptions, 'redoStack'> = {}) {
    return new ChangesetStore(state.changeset, { ...options, redoStack: state.redoStack });
  }

  /** The current changeset snapshot — persist this and/or stream it to the panel. */
  get current(): Changeset {
    return this.changeset;
  }

  /** The full serializable state (changeset + redo stack) — what `persist` writes and `fromState`
   *  reads. `redoStack` is copied so a held snapshot never sees later store mutations. */
  snapshot(): ChangesetState {
    return { changeset: this.changeset, redoStack: [...this.redoStack] };
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
    this.flush();
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
    this.flush();
    return last;
  }

  /** Re-apply the most recently undone edit. Returns the redone edit, or `undefined` when there is
   *  nothing to redo. */
  redo(): Edit | undefined {
    const edit = this.redoStack.pop();
    if (!edit) return undefined;
    this.changeset = addEdit(this.changeset, edit);
    this.flush();
    return edit;
  }

  /** Remove the edit at `index` (0-based). Dropping an arbitrary edit forks history — like a fresh
   *  `record` — so the redo stack is cleared (a redo tail earned before this deletion is no longer
   *  coherent). Out of range is a no-op returning `undefined`. Returns the removed edit. Panel-driven
   *  per-edit "remove" from the Diff tab (#10); the durable/shippable record only, never the page. */
  removeAt(index: number): Edit | undefined {
    const { edits } = this.changeset;
    if (index < 0 || index >= edits.length) return undefined;
    const removed = edits[index];
    this.changeset = {
      ...this.changeset,
      edits: [...edits.slice(0, index), ...edits.slice(index + 1)],
    };
    this.redoStack.length = 0;
    this.flush();
    return removed;
  }

  /** Wipe every edit AND the redo stack — the Diff tab's "clear session" (#10). Keeps the same
   *  changeset identity (url/createdAt/sessionId) so a subsequent record continues the same session. */
  clear(): void {
    this.changeset = { ...this.changeset, edits: [] };
    this.redoStack.length = 0;
    this.flush();
  }

  // Mirror the new full state through the injected port, best-effort: a rejected async write is
  // swallowed so a storage hiccup can't take down the turn (the in-memory state stays authoritative).
  private flush(): void {
    if (!this.persist) return;
    void Promise.resolve(this.persist(this.snapshot())).catch(() => {});
  }
}

// --- chrome.storage.session persistence ------------------------------------------------------

const KEY_PREFIX = 'changeset:';
const changesetKey = (tabId: number): string => `${KEY_PREFIX}${tabId}`;

/** The `chrome.storage.session`-shaped surface the persister needs — the subset we use, so a unit
 *  test can pass an in-memory fake and this module stays importable in jsdom (no real `chrome`). */
export interface SessionStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

// Default binding to the real `chrome.storage.session`, read lazily (per call, not at import) so a
// non-extension context that never persists doesn't dereference `chrome`.
function sessionArea(): SessionStorageArea {
  return chrome.storage.session as unknown as SessionStorageArea;
}

/** A `chrome.storage.session`-backed changeset state store for one tab: `save` mirrors a mutation,
 *  `load` rehydrates on SW wake, `clear` forgets a finished session. */
export interface SessionChangesetPersister {
  /** Persist a full {@link ChangesetState} — pass directly as `ChangesetStoreOptions.persist`. */
  readonly save: PersistChangesetState;
  /** Rehydrate the persisted state, or `undefined` when none is stored or the record is invalid. */
  load(): Promise<ChangesetState | undefined>;
  /** Drop the persisted state (turn ended / tab closed). */
  clear(): Promise<void>;
}

/**
 * Bind a {@link SessionChangesetPersister} to one tab, keyed `changeset:<tabId>` in
 * `chrome.storage.session` (distinct from `src/agent/session.ts`'s `session:<tabId>` thread record).
 * `area` is injectable — production omits it to use the real store; tests pass an in-memory fake.
 * `load` tolerates a legacy bare-`Changeset` record (wrapping it with an empty redo stack) and drops
 * anything that fails validation rather than trusting a corrupt or stale-schema value.
 */
export function createSessionChangesetPersister(
  tabId: number,
  area: SessionStorageArea = sessionArea(),
): SessionChangesetPersister {
  const key = changesetKey(tabId);
  return {
    save: (state) => area.set({ [key]: state }),
    async load() {
      const got = await area.get(key);
      const raw = got[key];
      if (raw === undefined) return undefined;
      const state = ChangesetState.safeParse(raw);
      if (state.success) return state.data;
      // Forward-compat: an earlier build may have stored a bare Changeset — adopt it, no redo tail.
      const legacy = ChangesetState.shape.changeset.safeParse(raw);
      return legacy.success ? { changeset: legacy.data, redoStack: [] } : undefined;
    },
    clear: () => area.remove(key),
  };
}
