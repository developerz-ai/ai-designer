// Pending diagnostics signals — the service worker's half of the debug-engine half of slice 06.
// The content script pushes a `diagnostics-signal` (CollectorSignal) for every runtime/network/
// a11y/layout signal the page collector captures; background.ts used to DROP them (messages.ts:
// `relayToPanel` returns null for the type), so a debug-mode turn observed nothing until the
// model's explicit `diagnostics` DomTool pull ran. This buffer keeps the signals per tab until
// they are folded: turn start drains buffered signals into the turn's diagnostics evidence,
// so real-time signals captured during SW startup/eviction survive instead of being lost.
//
// The buffer itself is in-memory, but no longer ONLY that: every signal reports through the
// injected `onChange` port, which background.ts binds to a `chrome.storage.session` persister
// (src/changeset/pending-diagnostics-persist.ts), and a woken SW re-seeds via {@link
// PendingDiagnostics.seed}. An eviction mid-turn therefore no longer loses the real-time
// evidence the collector streamed between the page load and the turn's drain.
// The mirror stays best-effort: the drain feeds `aggregate`/`correlate`, never a correctness
// gate, so a lost debounced write still degrades gracefully to the pull-based DomTool.
//
// Pure by construction: no `chrome.*`, no clock (signals carry their own `ts`). Instantiated
// once in background.ts; unit-tested directly.

import type { CollectorSignal } from '@/shared/diagnostics';

/** One buffered kind group: every pending signal for one `kind`, in arrival order. */
export interface PendingDiagnosticsGroup {
  readonly kind: CollectorSignal['kind'];
  readonly signals: readonly CollectorSignal[];
}

/** One tab's full buffered state — the unit the persistence port mirrors and {@link
 *  PendingDiagnostics.seed} restores. `dropped` rides along so a cap loss survives an
 *  eviction (the drain that surfaces it may run in a later worker). */
export interface PendingDiagnosticsSnapshot {
  readonly signals: readonly CollectorSignal[];
  readonly dropped: number;
}

/** Which signal produced an `onChange` report — the persistence binding debounces the churny
 *  `append` and writes the rest through (a drain/clear must not lose a race with eviction and
 *  resurrect already-folded signals). */
export type PendingDiagnosticsChangeKind = 'append' | 'drain' | 'clear';

/** The result of one {@link PendingDiagnostics.drain} call. */
export interface DrainDiagnosticsResult {
  /** The drained signals (empty when the tab has none). */
  readonly signals: CollectorSignal[];
  /** The tab's cap-drop count as it stood BEFORE this call — the call RESETS it to 0. */
  readonly dropped: number;
}

export interface PendingDiagnostics {
  /** Buffer one signal for a tab. Past the per-tab cap the oldest signals are dropped
   *  (counted — see {@link PendingDiagnostics.droppedCount}). */
  append(tabId: number, signal: CollectorSignal): void;
  /** Remove and return ALL buffered signals for a tab, resetting its cap-drop counter. */
  drain(tabId: number): DrainDiagnosticsResult;
  /** Remove only signals included in a successful report. */
  removeReported(tabId: number, signals: readonly CollectorSignal[]): void;
  /** Forget everything buffered for a tab (turn finalized / page navigated / tab closed) —
   *  including its drop counter. */
  clear(tabId: number): void;
  /** The remaining buffer grouped by kind, in first-seen kind order — a consumer iterates this
   *  without consuming (drain/clear do the consuming). */
  peekGroups(tabId: number): PendingDiagnosticsGroup[];
  /** How many of the tab's signals were dropped at the cap since the last `clear` or `drain`
   *  (0 when none). */
  droppedCount(tabId: number): number;
  /** Restore a persisted snapshot — SW-wake hydration only. Installs ONLY into an untouched
   *  tab slot (no buffered signals, no drop count): live signals that arrived before hydration
   *  finished are newer news than the mirror, and interleaving orders across an eviction would
   *  be a lie. Trimmed to the cap. Does NOT report through `onChange` (it mirrors what the
   *  persister already holds). */
  seed(tabId: number, snapshot: PendingDiagnosticsSnapshot): void;
}

export interface PendingDiagnosticsOptions {
  /** Max buffered signals per tab; oldest are dropped past the cap. Default 200. */
  readonly cap?: number;
  /** Reports each state-changing call with the tab's NEW snapshot (`null` = the tab is now
   *  untracked) so the SW can mirror the buffer to `chrome.storage.session`. Called
   *  synchronously after the mutation; must not throw (fire-and-forget persistence). Pure
   *  no-ops (a drain/clear of an empty tab) do not report. */
  readonly onChange?: (
    tabId: number,
    snapshot: PendingDiagnosticsSnapshot | null,
    kind: PendingDiagnosticsChangeKind,
  ) => void;
}

const DEFAULT_CAP = 200;

/** A per-tab FIFO buffer of collector diagnostics signals. */
export function createPendingDiagnostics(
  options: PendingDiagnosticsOptions = {},
): PendingDiagnostics {
  const cap = options.cap ?? DEFAULT_CAP;
  const buffers = new Map<number, CollectorSignal[]>();
  const dropped = new Map<number, number>();

  const report = (tabId: number, kind: PendingDiagnosticsChangeKind): void => {
    if (!options.onChange) return;
    const buf = buffers.get(tabId);
    const drops = dropped.get(tabId) ?? 0;
    const snapshot: PendingDiagnosticsSnapshot | null =
      (buf === undefined || buf.length === 0) && drops === 0
        ? null
        : { signals: [...(buf ?? [])], dropped: drops };
    options.onChange(tabId, snapshot, kind);
  };

  return {
    append(tabId, signal) {
      const buf = buffers.get(tabId) ?? [];
      buf.push(signal);
      if (buf.length > cap) {
        const excess = buf.length - cap;
        buf.splice(0, excess);
        dropped.set(tabId, (dropped.get(tabId) ?? 0) + excess);
      }
      buffers.set(tabId, buf);
      report(tabId, 'append');
    },

    drain(tabId) {
      const droppedSoFar = dropped.get(tabId) ?? 0;
      dropped.delete(tabId);
      const buf = buffers.get(tabId);
      if (!buf || buf.length === 0) {
        if (droppedSoFar > 0) report(tabId, 'drain');
        return { signals: [], dropped: droppedSoFar };
      }
      buffers.delete(tabId);
      report(tabId, 'drain');
      return { signals: [...buf], dropped: droppedSoFar };
    },

    removeReported(tabId, signals) {
      const buf = buffers.get(tabId);
      if (!buf || signals.length === 0) return;
      const reported = new Set(signals);
      const remaining = buf.filter((signal) => !reported.has(signal));
      if (remaining.length === buf.length) return;
      if (remaining.length) buffers.set(tabId, remaining);
      else buffers.delete(tabId);
      dropped.delete(tabId);
      report(tabId, 'drain');
    },

    clear(tabId) {
      const tracked = buffers.has(tabId) || dropped.has(tabId);
      buffers.delete(tabId);
      dropped.delete(tabId);
      if (tracked) report(tabId, 'clear');
    },

    peekGroups(tabId) {
      const buf = buffers.get(tabId);
      if (!buf || buf.length === 0) return [];
      const key = (signal: CollectorSignal): string => signal.kind;
      const byKind = new Map<string, CollectorSignal[]>();
      for (const signal of buf) {
        const group = byKind.get(key(signal));
        if (group) group.push(signal);
        else byKind.set(key(signal), [signal]);
      }
      const groups: PendingDiagnosticsGroup[] = [];
      for (const signals of byKind.values()) {
        const first = signals[0];
        if (!first) continue;
        groups.push({ kind: first.kind, signals: [...signals] });
      }
      return groups;
    },

    droppedCount(tabId) {
      return dropped.get(tabId) ?? 0;
    },

    seed(tabId, snapshot) {
      // Only an untouched slot — live signals beat the mirror.
      if (buffers.has(tabId) || dropped.has(tabId)) return;
      if (snapshot.signals.length > 0) buffers.set(tabId, [...snapshot.signals].slice(-cap));
      if (snapshot.dropped > 0) dropped.set(tabId, snapshot.dropped);
    },
  };
}
