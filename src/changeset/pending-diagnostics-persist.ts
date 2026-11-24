// chrome.storage.session mirror for the SW's pending-diagnostics buffer (#06 debug engine).
// The buffer (src/changeset/pending-diagnostics.ts) is the in-memory half of the real-time
// diagnostics pipeline: the content script pushes a `diagnostics-signal` (CollectorSignal) for
// every page signal, and background.ts folds them into a turn's diagnostics evidence at turn
// start / before report build. Before this module an SW eviction mid-turn lost every signal the
// collector had streamed since the page load — a debug turn then observed nothing until its own
// explicit `diagnostics` DomTool pull ran.
//
// This mirror lives beside the changeset mirrors (same storage area, same per-tab keying:
// `pendingDiagnostics:<tabId>` next to `changeset:<tabId>`), is Zod-validated on load, and is
// bounded by construction: the buffer caps at 200 signals/tab, so a snapshot can never grow past
// that.
//
// WRITE CADENCE — the buffer churns (one `append` per page signal, bursts during page load), so
// appends are DEBOUNCED per tab (trailing): long enough to fold a page-load burst into one write,
// short enough that the idle-eviction window (~30s) dwarfs it. A lost debounce costs at most the
// newest few signals of an evicted worker, which the never-a-correctness-gate contract absorbs.
// The shrinking ops (`drain` / `clear`) write THROUGH: losing one to an eviction would resurrect
// signals a drain already folded into the turn's evidence (re-reported as fresh evidence) —
// exactly the class #9/#148 closed for recorder events, here applied to diagnostics.
//
// Chrome-free by construction: the storage area is the injected `SessionStorageArea` shape the
// changeset persister already defines. Instantiated once in background.ts; every write is
// fire-and-forget + self-catching (persistence trouble must never reach the diagnostics path).
//
// Pure by construction: no `chrome.*` reachable from the buffer itself (only injected here),
// and the load path validates against `CollectorSignal` so a mangled record can't inject an
// arbitrary signal kind into evidence.

import { z } from 'zod';
import type { PendingDiagnosticsSnapshot } from '@/changeset/pending-diagnostics';
import { type SessionStorageArea, sessionArea } from '@/changeset/store';
import { CollectorSignal } from '@/shared/diagnostics';

const KEY_PREFIX = 'pendingDiagnostics:';
const pendingKey = (tabId: number): string => `${KEY_PREFIX}${tabId}`;

// Trailing debounce for the churny `append` path. Long enough to fold a page-load burst into one
// write, short enough that the idle-eviction window (~30s) dwarfs it.
export const PENDING_DIAGNOSTICS_PERSIST_DEBOUNCE_MS = 300;

// What `loadAll` trusts. `.max(400)` is a corruption guard only (double the buffer cap) — a valid
// producer can never exceed the cap, so anything larger is a mangled record, dropped whole.
const StoredPendingDiagnosticsSnapshot = z.object({
  signals: z.array(CollectorSignal).max(400),
  dropped: z.number().int().nonnegative(),
});

export interface PendingDiagnosticsPersister {
  /** Mirror one buffer change — the `PendingDiagnosticsOptions.onChange` binding. `null`
   *  deletes the tab's key. Debounces `append`, writes `drain`/`clear` through (see the header).
   *  Never throws; a storage failure only degrades a later wake. */
  save(
    tabId: number,
    snapshot: PendingDiagnosticsSnapshot | null,
    kind: 'append' | 'drain' | 'clear',
  ): void;
  /** Every persisted snapshot, validated — SW-boot hydration (`PendingDiagnostics.seed`). Invalid
   *  records are dropped AND best-effort deleted so a mangled key doesn't linger all session. */
  loadAll(): Promise<Map<number, PendingDiagnosticsSnapshot>>;
}

export function createPendingDiagnosticsPersister(
  area: SessionStorageArea = sessionArea(),
  debounceMs: number = PENDING_DIAGNOSTICS_PERSIST_DEBOUNCE_MS,
): PendingDiagnosticsPersister {
  // tabId -> the pending trailing write (its latest snapshot rides the closure of the timer).
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const write = (tabId: number, snapshot: PendingDiagnosticsSnapshot | null): void => {
    const key = pendingKey(tabId);
    const op =
      snapshot === null
        ? area.remove(key)
        : area.set({ [key]: { signals: [...snapshot.signals], dropped: snapshot.dropped } });
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
      const restored = new Map<number, PendingDiagnosticsSnapshot>();
      const all = await area.get(null);
      for (const [key, raw] of Object.entries(all)) {
        if (!key.startsWith(KEY_PREFIX)) continue;
        const tabId = Number.parseInt(key.slice(KEY_PREFIX.length), 10);
        const parsed = StoredPendingDiagnosticsSnapshot.safeParse(raw);
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
