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
  /** Buffer one event for a tab. Past the per-tab cap the oldest events are dropped. */
  append(tabId: number, event: MutationEvent): void;
  /** Remove and return the buffered events matching `selectorValue` (exact match on
   *  `event.selector.value`). When `selectorValue` is omitted AND the buffer holds exactly
   *  one distinct selector value, drains them all; with several distinct values it drains
   *  nothing (ambiguous — the caller must name its selector). */
  drain(tabId: number, selectorValue?: string): MutationEvent[];
  /** Forget everything buffered for a tab (turn finalized / page navigated). */
  clear(tabId: number): void;
  /** The remaining buffer grouped by selector value, in first-seen order — the turn-end
   *  auto-finalize iterates this without consuming (drain/clear do the consuming). */
  peekGroups(tabId: number): PendingGroup[];
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

  return {
    append(tabId, event) {
      const buf = buffers.get(tabId) ?? [];
      buf.push(event);
      if (buf.length > cap) buf.splice(0, buf.length - cap);
      buffers.set(tabId, buf);
    },

    drain(tabId, selectorValue) {
      const buf = buffers.get(tabId);
      if (!buf || buf.length === 0) return [];
      let target = selectorValue;
      if (target === undefined) {
        const distinct = new Set(buf.map((e) => e.selector.value));
        if (distinct.size !== 1) return [];
        // Exactly one distinct selector value — the group is unambiguous.
        target = [...distinct][0];
      }
      const matched: MutationEvent[] = [];
      const rest: MutationEvent[] = [];
      for (const event of buf) {
        (event.selector.value === target ? matched : rest).push(event);
      }
      if (rest.length === 0) buffers.delete(tabId);
      else buffers.set(tabId, rest);
      return matched;
    },

    clear(tabId) {
      buffers.delete(tabId);
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
 */
export function foldMutationEvents(edit: Edit, events: readonly MutationEvent[]): Edit {
  if (events.length === 0) return edit;

  const changes = mergeStyleChanges(events);
  const attrs = mergeAttrChanges(events);
  const classes = mergeClassChanges(events);
  // The first drained structural event wins; extras are dropped — one durable structural op per
  // edit. A second insertNode/moveNode on the same selector belongs to its own Edit (the model
  // can recordEdit twice, or the turn-end auto-finalize groups it separately).
  const structuralEvent = events.find((e) => e.structural !== undefined);
  const text = mergeTextChanges(events);

  return {
    ...edit,
    changes: changes ? changes.merged : edit.changes,
    attrs: attrs ? attrs.merged : edit.attrs,
    classes: classes ? classes.merged : edit.classes,
    structural: structuralEvent?.structural ?? edit.structural,
    text: text ?? edit.text,
    frameworkHints: mergeFrameworkHints(edit.frameworkHints, events),
  };
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

/** `classes`: per name, opposite ops cancel (add+remove in EITHER order drops both); a name
 *  whose events all agree keeps the single op (repeats dedupe). */
function mergeClassChanges(
  events: readonly MutationEvent[],
): { merged: ClassChange[] } | undefined {
  let saw = false;
  // 'conflict' = the name saw both ops at some point — cancels regardless of what follows.
  const byName = new Map<string, ClassChange['op'] | 'conflict'>();
  for (const event of events) {
    const cc = event.classChange;
    if (!cc) continue;
    saw = true;
    const prior = byName.get(cc.name);
    if (prior === undefined) byName.set(cc.name, cc.op);
    else if (prior !== cc.op) byName.set(cc.name, 'conflict');
  }
  if (!saw) return undefined;
  const merged: ClassChange[] = [];
  for (const [name, op] of byName) {
    if (op === 'conflict') continue;
    merged.push({ name, op });
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
