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
// background.ts; unit-tested directly.

import type {
  AttrChange,
  ClassChange,
  Edit,
  StableSelector,
  StyleChange,
} from '@/shared/changeset';
import type { MutationEvent } from '@/shared/messages';

/** One buffered selector group: every pending event for one `selector.value`, in arrival
 *  order, with the full selector of its first event (the one an auto-finalized Edit uses). */
export interface PendingGroup {
  readonly selector: StableSelector;
  readonly events: readonly MutationEvent[];
}

export interface PendingMutations {
  /** Buffer one event for a tab. Past the per-tab cap the oldest events are dropped (counted —
   *  see {@link PendingMutations.droppedCount}). */
  append(tabId: number, event: MutationEvent): void;
  /** Remove and return the buffered events matching `selectorValue` (exact match on
   *  `event.selector.value`). When `selectorValue` is omitted AND the buffer holds exactly
   *  one distinct selector value, drains them all; with several distinct values it drains
   *  nothing (ambiguous — the caller must name its selector). The same single-group rule
   *  rescues an EXPLICIT selector that matched nothing: a model paraphrase of the one
   *  buffered selector is still unambiguous, so it drains the group rather than splitting
   *  one visual change into a model Edit + an "Auto-recorded" duplicate. */
  drain(tabId: number, selectorValue?: string): MutationEvent[];
  /** Remove ONE buffered event — the SW's answer to a `recorder-revert` (the content script
   *  undid a mutation, so its event must never fold into the durable changeset). Matches by
   *  `ts` equality first; falls back to the LAST buffered event with the same
   *  `selector.value` + `kind` (a re-generated clock could collide timestamps). Returns
   *  whether it removed one. */
  remove(tabId: number, event: MutationEvent): boolean;
  /** Forget everything buffered for a tab (turn finalized / page navigated / tab closed) —
   *  including its drop counter. */
  clear(tabId: number): void;
  /** The remaining buffer grouped by selector value, in first-seen order — the turn-end
   *  auto-finalize iterates this without consuming (drain/clear do the consuming). */
  peekGroups(tabId: number): PendingGroup[];
  /** How many of the tab's events were dropped at the cap since the last `clear` (0 when
   *  none) — the turn-end auto-finalize surfaces the loss in the edit intent. */
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
  // Per-tab count of events dropped at the cap — the auto-finalize intent surfaces the loss.
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
      const buf = buffers.get(tabId);
      if (!buf || buf.length === 0) return [];
      const distinct = new Set(buf.map((e) => e.selector.value));
      let target = selectorValue;
      if (target === undefined) {
        if (distinct.size !== 1) return [];
        // Exactly one distinct selector value — the group is unambiguous.
        target = [...distinct][0];
      }
      const matched: MutationEvent[] = [];
      const rest: MutationEvent[] = [];
      for (const event of buf) {
        (event.selector.value === target ? matched : rest).push(event);
      }
      if (matched.length === 0) {
        // The named selector matched nothing. Same single-group rule as the no-selector
        // path: when the buffer holds exactly one distinct selector value, that group is
        // unambiguously what the caller means — drain it all rather than leave it for the
        // auto-finalize to duplicate.
        if (distinct.size !== 1) return [];
        buffers.delete(tabId);
        return [...buf];
      }
      if (rest.length === 0) buffers.delete(tabId);
      else buffers.set(tabId, rest);
      return matched;
    },

    remove(tabId, event) {
      const buf = buffers.get(tabId);
      if (!buf || buf.length === 0) return false;
      let index = buf.findIndex((e) => e.ts === event.ts);
      if (index === -1) {
        // Fallback: the LAST buffered event with the same selector value + kind (the revert
        // unwinds LIFO, so the newest matching entry is the one that died).
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

/**
 * Fold drained recorder events into a model-authored Edit. Ground truth WINS per mechanical
 * family: when any drained event carried that family's field, the merged buffer value replaces
 * the model's (`changes`/`attrs`/`classes`/`structural`/`text`) — the page's own record beats
 * the model restating its tool calls. Families no event carried keep the model's values
 * (back-compat with a pre-#9 producer, whose events have none of the optional fields).
 * `frameworkHints` is the exception: a union of the model's + the events', deduped (hints are
 * markers, not deltas — more sources only help source-mapping).
 *
 * STRUCTURAL SPILLOVER: one Edit carries ONE structural op, but a selector group can hold
 * several (insert two children, move-then-remove). The FIRST structural event folds into
 * `folded`; every ADDITIONAL one becomes its own auto-recorded Edit in `spillover` (never
 * silently dropped — a dropped op would ship a changeset that can't reconstruct the page).
 * Groups are keyed by selector, so the caller canNOT pre-split these; the split must happen
 * here. Spillover edits carry only the structural delta + the group's hint union.
 */
export function foldMutationEvents(
  edit: Edit,
  events: readonly MutationEvent[],
): { folded: Edit; spillover: Edit[] } {
  if (events.length === 0) return { folded: edit, spillover: [] };

  const changes = mergeStyleChanges(events);
  const attrs = mergeAttrChanges(events);
  const classes = mergeClassChanges(events);
  const structuralEvents = events.filter((e) => e.structural !== undefined);
  const text = mergeTextChanges(events);

  const folded: Edit = {
    ...edit,
    changes: changes ? changes.merged : edit.changes,
    attrs: attrs ? attrs.merged : edit.attrs,
    classes: classes ? classes.merged : edit.classes,
    structural: structuralEvents[0]?.structural ?? edit.structural,
    text: text ?? edit.text,
    frameworkHints: mergeFrameworkHints(edit.frameworkHints, events),
  };

  // One auto-recorded Edit per ADDITIONAL structural event, in arrival order. Selector =
  // the group's own (the first event's full selector, same rule peekGroups uses); hints =
  // the union of the group's (not the model's — this edit is page-grounded only).
  const groupSelector = events[0]?.selector ?? edit.selector;
  const groupHints = mergeFrameworkHints([], events);
  const spillover: Edit[] = [];
  for (const event of structuralEvents.slice(1)) {
    if (!event.structural) continue;
    spillover.push({
      intent: 'Auto-recorded structural edit (additional op on same selector)',
      selector: groupSelector,
      changes: [],
      attrs: [],
      classes: [],
      structural: event.structural,
      frameworkHints: groupHints,
    });
  }

  return { folded, spillover };
}

// --- per-family merges -----------------------------------------------------
// Each returns `undefined` when NO drained event carried the family (the model's value then
// stands), else the merged ground truth — possibly an EMPTY array when every delta canceled
// out (a change applied then reverted is truthfully "no net change", and must not fall back
// to the model's stale delta).

/** `changes`: per prop, FIRST event's before + LAST event's after; no-op pairs dropped. */
function mergeStyleChanges(
  events: readonly MutationEvent[],
): { merged: StyleChange[] } | undefined {
  let saw = false;
  const byProp = new Map<string, { before: string | null; after: string }>();
  for (const event of events) {
    for (const sc of event.styleChanges ?? []) {
      saw = true;
      const existing = byProp.get(sc.prop);
      if (existing) existing.after = sc.after;
      else byProp.set(sc.prop, { before: sc.before, after: sc.after });
    }
  }
  if (!saw) return undefined;
  const merged: StyleChange[] = [];
  for (const [prop, { before, after }] of byProp) {
    if (before === after) continue;
    merged.push({ prop, before, after });
  }
  return { merged };
}

/** `attrs`: per name, FIRST before + LAST after; no-op pairs dropped. */
function mergeAttrChanges(events: readonly MutationEvent[]): { merged: AttrChange[] } | undefined {
  let saw = false;
  const byName = new Map<string, { before: string | null; after: string | null }>();
  for (const event of events) {
    const ac = event.attrChange;
    if (!ac) continue;
    saw = true;
    const existing = byName.get(ac.name);
    if (existing) existing.after = ac.after;
    else byName.set(ac.name, { before: ac.before, after: ac.after });
  }
  if (!saw) return undefined;
  const merged: AttrChange[] = [];
  for (const [name, { before, after }] of byName) {
    if (before === after) continue;
    merged.push({ name, before, after });
  }
  return { merged };
}

/** `classes`: PARITY per name. The producer emits a delta ONLY when the op actually changed
 *  the class list (src/dom/mutate.ts — a no-op addClass of an already-present class emits
 *  nothing), so the real deltas for a name strictly alternate ops. The net is then the count's
 *  parity: ODD keeps the FIRST op, EVEN drops the name entirely (the toggles canceled out). */
function mergeClassChanges(
  events: readonly MutationEvent[],
): { merged: ClassChange[] } | undefined {
  let saw = false;
  const byName = new Map<string, { first: ClassChange['op']; count: number }>();
  for (const event of events) {
    const cc = event.classChange;
    if (!cc) continue;
    saw = true;
    const entry = byName.get(cc.name);
    if (entry) entry.count += 1;
    else byName.set(cc.name, { first: cc.op, count: 1 });
  }
  if (!saw) return undefined;
  const merged: ClassChange[] = [];
  for (const [name, { first, count }] of byName) {
    if (count % 2 === 0) continue;
    merged.push({ name, op: first });
  }
  return { merged };
}

/** `text`: FIRST textChange's before + LAST textChange's after (bounded by the producer). */
function mergeTextChanges(events: readonly MutationEvent[]): Edit['text'] {
  let merged: { before: string; after: string } | undefined;
  for (const event of events) {
    const tc = event.textChange;
    if (!tc) continue;
    merged = merged === undefined ? { ...tc } : { before: merged.before, after: tc.after };
  }
  return merged;
}

/** `frameworkHints`: the model's hints first, then any event hints, deduped by value. */
function mergeFrameworkHints(
  modelHints: readonly string[],
  events: readonly MutationEvent[],
): string[] {
  const seen = new Set(modelHints);
  const merged = [...modelHints];
  for (const event of events) {
    for (const hint of event.frameworkHints ?? []) {
      if (seen.has(hint)) continue;
      seen.add(hint);
      merged.push(hint);
    }
  }
  return merged;
}
