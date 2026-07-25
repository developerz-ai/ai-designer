// Pending recorder mutations — the service worker's half of the #9 changeset recorder.
// The content script pushes a `recorder-event` (MutationEvent) for every reversible page
// mutation the agent applies; the SW used to DROP them (relay.ts returns null for the
// type), so a durable Edit's mechanical fields (changes/attrs/classes/structural/text)
// populated only when the model restated its own tool calls in `recordEdit`. This buffer
// keeps the events per tab until they are folded: `recordEdit` drains the group matching
// its selector (ground truth wins per family, see {@link foldMutationEvents}), turn end
// auto-finalizes whatever is left into explicit "Auto-recorded" edits, and a page
// navigation wipes the tab's buffer (the live edits died with the old document).
//
// The buffer is IN-MEMORY ONLY: an SW eviction mid-turn loses the pending ground truth (the
// durable changeset survives in chrome.storage.session — this buffer does not). A resumed
// turn's `recordEdit` then drains nothing and falls back to the model-supplied values — the
// pre-#9 behavior — until new mutations arrive and re-seed the buffer. The fold is an
// accuracy upgrade, never a correctness gate, so the loss degrades gracefully.
//
// Pure by construction: no `chrome.*`, no clock (arrival order is mutation order — the bus
// delivers a tab's events in the order the mutations ran). Instantiated once in
// background.ts; unit-tested directly. The fold itself lives in fold-mutations.ts (SRP split)
// and is re-exported here so existing importers keep working.

import type { StableSelector } from '@/shared/changeset';
import type { MutationEvent } from '@/shared/messages';

export { foldMutationEvents } from '@/changeset/fold-mutations';

/** One buffered selector group: every pending event for one `selector.value`, in arrival
 *  order, with the full selector of its first event (the one an auto-finalized Edit uses). */
export interface PendingGroup {
  readonly selector: StableSelector;
  readonly events: readonly MutationEvent[];
}

/** The result of one {@link PendingMutations.drain} call. */
export interface DrainResult {
  /** The drained events (empty on no match / multi-group ambiguity). */
  readonly events: MutationEvent[];
  /** The tab's cap-drop count as it stood BEFORE this call — the call RESETS it to 0, so the
   *  consumer that drains is the one that must surface the loss. */
  readonly dropped: number;
  /** True when the single-group rescue fired: the caller's selector matched nothing, but the
   *  buffer held exactly one plausibly-same group, which was drained instead. */
  readonly rescued: boolean;
}

export interface PendingMutations {
  /** Buffer one event for a tab. Past the per-tab cap the oldest events are dropped (counted —
   *  see {@link PendingMutations.droppedCount}). */
  append(tabId: number, event: MutationEvent): void;
  /** Remove and return the buffered events matching `selectorValue` (exact match on
   *  `event.selector.value`). No value + exactly one distinct buffered value drains them all;
   *  several distinct values drains nothing (ambiguous — the caller must name its selector).
   *  The same single-group rule RESCUES an explicit selector that matched nothing, behind a
   *  plausibility gate (flagged `rescued` in the result): the one buffered value must contain
   *  the caller's value or vice versa (case-sensitive) — the model's selector is plausibly a
   *  paraphrase of the same target. An implausible miss drains nothing and leaves the group
   *  for the turn-end auto-finalize; draining it would fold ground truth into the WRONG edit.
   *  The call always snapshots + resets the tab's cap-drop counter (see DrainResult.dropped). */
  drain(tabId: number, selectorValue?: string): DrainResult;
  /** Remove ONE buffered event — the SW's answer to a `recorder-revert` (the content script
   *  undid a mutation, so its event must never fold into the durable changeset). Primary match
   *  scans FROM THE END requiring `ts` AND `selector.value` AND `kind`: `Date.now()`'s ms
   *  resolution makes same-ts collisions real in a fast tool burst, and undo unwinds LIFO, so
   *  the NEWEST fully-matching event is the one that died. Falls back to the LAST event with
   *  the same selector + kind (a re-generated clock could collide timestamps). Returns whether
   *  it removed one. */
  remove(tabId: number, event: MutationEvent): boolean;
  /** Forget everything buffered for a tab (turn finalized / page navigated / tab closed) —
   *  including its drop counter. */
  clear(tabId: number): void;
  /** The remaining buffer grouped by selector value, in first-seen order — the turn-end
   *  auto-finalize iterates this without consuming (drain/clear do the consuming). */
  peekGroups(tabId: number): PendingGroup[];
  /** How many of the tab's events were dropped at the cap since the last `clear` or `drain`
   *  (0 when none) — the turn-end auto-finalize surfaces the loss in the edit intent. */
  droppedCount(tabId: number): number;
}

export interface PendingMutationsOptions {
  /** Max buffered events per tab; oldest are dropped past the cap. Default 200 — a runaway
   *  mutation loop can't grow the buffer without bound. */
  readonly cap?: number;
}

const DEFAULT_CAP = 200;

/** A per-tab FIFO buffer of recorder MutationEvents. */
export function createPendingMutations(options: PendingMutationsOptions = {}): PendingMutations {
  const cap = options.cap ?? DEFAULT_CAP;
  const buffers = new Map<number, MutationEvent[]>();
  // Per-tab count of events dropped at the cap — drain snapshots + resets it, the auto-finalize
  // reads whatever is left via droppedCount.
  const dropped = new Map<number, number>();

  return {
    append(tabId, event) {
      const buf = buffers.get(tabId) ?? [];
      buf.push(event);
      if (buf.length > cap) {
        const excess = buf.length - cap;
        buf.splice(0, excess);
        dropped.set(tabId, (dropped.get(tabId) ?? 0) + excess);
      }
      buffers.set(tabId, buf);
    },

    drain(tabId, selectorValue) {
      // Snapshot + reset the cap-drop counter FIRST: it resets on EVERY drain call, whatever
      // the outcome, so the recordEdit that consumes the group also consumes its loss marker.
      const droppedSoFar = dropped.get(tabId) ?? 0;
      dropped.delete(tabId);
      const buf = buffers.get(tabId);
      if (!buf || buf.length === 0) return { events: [], dropped: droppedSoFar, rescued: false };
      const distinct = new Set(buf.map((e) => e.selector.value));
      const distinctValues = [...distinct];
      let target = selectorValue;
      if (target === undefined) {
        // Exactly one distinct selector value — the group is unambiguous.
        const only = distinctValues[0];
        if (distinctValues.length !== 1 || only === undefined) {
          return { events: [], dropped: droppedSoFar, rescued: false };
        }
        target = only;
      }
      const matched: MutationEvent[] = [];
      const rest: MutationEvent[] = [];
      for (const event of buf) {
        (event.selector.value === target ? matched : rest).push(event);
      }
      if (matched.length === 0) {
        // Single-group rescue behind the plausibility gate (see the interface doc): the one
        // buffered group drains only when its value contains the caller's or vice versa. An
        // implausible miss must NOT steal the group — return empty, leave it for auto-finalize.
        const groupValue = distinctValues.length === 1 ? distinctValues[0] : undefined;
        if (
          groupValue === undefined ||
          !(target.includes(groupValue) || groupValue.includes(target))
        ) {
          return { events: [], dropped: droppedSoFar, rescued: false };
        }
        buffers.delete(tabId);
        return { events: [...buf], dropped: droppedSoFar, rescued: true };
      }
      if (rest.length === 0) buffers.delete(tabId);
      else buffers.set(tabId, rest);
      return { events: matched, dropped: droppedSoFar, rescued: false };
    },

    remove(tabId, event) {
      const buf = buffers.get(tabId);
      if (!buf || buf.length === 0) return false;
      let index = -1;
      // Primary: FROM THE END, ts + selector.value + kind (see the interface doc for why).
      for (let i = buf.length - 1; i >= 0; i--) {
        const candidate = buf[i];
        if (
          candidate &&
          candidate.ts === event.ts &&
          candidate.selector.value === event.selector.value &&
          candidate.kind === event.kind
        ) {
          index = i;
          break;
        }
      }
      if (index === -1) {
        // Fallback: the LAST event with the same selector value + kind (a collided clock).
        for (let i = buf.length - 1; i >= 0; i--) {
          const candidate = buf[i];
          if (
            candidate &&
            candidate.selector.value === event.selector.value &&
            candidate.kind === event.kind
          ) {
            index = i;
            break;
          }
        }
      }
      if (index === -1) return false;
      buf.splice(index, 1);
      if (buf.length === 0) buffers.delete(tabId);
      return true;
    },

    clear(tabId) {
      buffers.delete(tabId);
      dropped.delete(tabId);
    },

    peekGroups(tabId) {
      const buf = buffers.get(tabId);
      if (!buf || buf.length === 0) return [];
      // Group by selector value; Map insertion order preserves first-seen group order.
      const byValue = new Map<string, MutationEvent[]>();
      for (const event of buf) {
        const group = byValue.get(event.selector.value);
        if (group) group.push(event);
        else byValue.set(event.selector.value, [event]);
      }
      const groups: PendingGroup[] = [];
      for (const events of byValue.values()) {
        const first = events[0];
        if (!first) continue;
        groups.push({ selector: first.selector, events: [...events] });
      }
      return groups;
    },

    droppedCount(tabId) {
      return dropped.get(tabId) ?? 0;
    },
  };
}
