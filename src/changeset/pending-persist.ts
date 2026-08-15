// chrome.storage.session mirror for the SW's pending-mutations buffer (#148 item 3). The buffer
// (src/changeset/pending-mutations.ts) is the in-memory half of the #9 recorder fold; before this
// module an SW eviction mid-turn lost the pending ground truth and a resumed turn's `recordEdit`
// fell back to the model-supplied values — the pre-#9 behavior. The mirror lives beside the
// `ChangesetState` record (same storage area, same per-tab keying: `pendingMutations:<tabId>`
// next to `changeset:<tabId>`), is Zod-validated on load, and is bounded by construction: the
// buffer caps at 200 events/tab, so a snapshot can never grow past that.
//
// WRITE CADENCE — the buffer churns (one `append` per page mutation, a `batch` is N of them), so
// appends are DEBOUNCED per tab (trailing); a lost debounce window costs at most the newest few
// events of an evicted worker, which the fold's never-a-correctness-gate contract absorbs. The
// shrinking ops (`drain` / `remove` / `clear`) write THROUGH: losing one of those to an eviction
// would resurrect events a recordEdit already folded (double-recorded deltas) or a revert already
// retracted (a phantom) — the exact corruptions #9 spent review rounds closing.
//
// Chrome-free by construction: the storage area is the injected `SessionStorageArea` shape the
// changeset persister already defines. Instantiated once in background.ts; every write is
// fire-and-forget + self-catching (persistence trouble must never reach the recorder path).

import { z } from 'zod';
import type { PendingChangeKind, PendingSnapshot } from '@/changeset/pending-mutations';
import { type SessionStorageArea, sessionArea } from '@/changeset/store';
import { MutationEvent } from '@/shared/messages';

const KEY_PREFIX = 'pendingMutations:';
const pendingKey = (tabId: number): string => `${KEY_PREFIX}${tabId}`;

/** Trailing debounce for the churny `append` path. Long enough to fold a tool burst into one
 *  write, short enough that the idle-eviction window (~30s) dwarfs it. */
export const PENDING_PERSIST_DEBOUNCE_MS = 300;

// What `load` trusts. `.max(400)` is a corruption guard only (double the buffer cap) — a valid
// producer can never exceed the cap, so anything larger is a mangled record, dropped whole.
const StoredPendingSnapshot = z.object({
  events: z.array(MutationEvent).max(400),
  dropped: z.number().int().nonnegative(),
});

export interface PendingMutationsPersister {
  /** Mirror one buffer change — the `PendingMutationsOptions.onChange` binding. `null` deletes
   *  the tab's key. Debounces `append`, writes everything else through (see the header). Never
   *  throws; a storage failure only degrades a later wake. */
  save(tabId: number, snapshot: PendingSnapshot | null, kind: PendingChangeKind): void;
  /** Every persisted snapshot, validated — SW-boot hydration (`PendingMutations.seed`). Invalid
   *  records are dropped AND best-effort deleted so a mangled key doesn't linger all session. */
  loadAll(): Promise<Map<number, PendingSnapshot>>;
}

export function createPendingMutationsPersister(
  area: SessionStorageArea = sessionArea(),
  debounceMs: number = PENDING_PERSIST_DEBOUNCE_MS,
): PendingMutationsPersister {
  // tabId -> the pending trailing write (its latest snapshot rides the closure of the timer).
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const write = (tabId: number, snapshot: PendingSnapshot | null): void => {
    const key = pendingKey(tabId);
    const op =
      snapshot === null
        ? area.remove(key)
        : area.set({ [key]: { events: [...snapshot.events], dropped: snapshot.dropped } });
    void Promise.resolve(op).catch(() => {});
  };

  return {
    save(tabId, snapshot, kind) {
      const pending = timers.get(tabId);
      if (pending !== undefined) {
        clearTimeout(pending);
        timers.delete(tabId);
      }
      if (kind === 'append' && snapshot !== null) {
        const timer = setTimeout(() => {
          timers.delete(tabId);
          write(tabId, snapshot);
        }, debounceMs);
        timers.set(tabId, timer);
        return;
      }
      // Shrinking ops write through — and having cancelled the trailing append above, they can't
      // be overwritten by a stale, larger snapshot a moment later.
      write(tabId, snapshot);
    },

    async loadAll() {
      const restored = new Map<number, PendingSnapshot>();
      const all = await area.get(null);
      for (const [key, raw] of Object.entries(all)) {
        if (!key.startsWith(KEY_PREFIX)) continue;
        const tabId = Number.parseInt(key.slice(KEY_PREFIX.length), 10);
        const parsed = StoredPendingSnapshot.safeParse(raw);
        if (!Number.isInteger(tabId) || !parsed.success) {
          void Promise.resolve(area.remove(key)).catch(() => {});
          continue;
        }
        restored.set(tabId, parsed.data);
      }
      return restored;
    },
  };
}
