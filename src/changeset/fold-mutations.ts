// The recordEdit fold — the accuracy half of the #9 changeset recorder (split out of
// pending-mutations.ts, which owns the buffer, to keep each module under the 200-LOC budget;
// the class-window machinery lives in fold-classes.ts, #142).
// `foldMutationEvents` merges a drained selector group's recorder events into the model-authored
// Edit. Ground truth WINS per mechanical family: when any drained event carried that family's
// field, the merged buffer value replaces the model's (`changes`/`attrs`/`classes`/`structural`/
// `text`) — the page's own record beats the model restating its tool calls. Families no event
// carried keep the model's values (back-compat with a pre-#9 producer, whose events have none of
// the optional fields). `frameworkHints` is the exception: a union of the model's + the events',
// deduped (hints are markers, not deltas — more sources only help source-mapping).
//
// Pure by construction: no `chrome.*`, no clock. Unit-tested via test/unit/pending-mutations.test.ts.

import { mergeClassChanges } from '@/changeset/fold-classes';
import type { AttrChange, Edit, StyleChange } from '@/shared/changeset';
import type { MutationEvent } from '@/shared/messages';

/**
 * Fold drained recorder events into a model-authored Edit (see the module header for the
 * ground-truth-wins rule).
 *
 * SELECTOR HEALING: with events in hand, the fold adopts the FIRST event's selector (strategy +
 * fragile included) as the folded Edit's selector — the event's selector is the one that actually
 * RESOLVED on the page, so a model paraphrase (the drain rescue) is healed to ground truth. On an
 * exact-match drain this is a no-op-ish rewrite to the same value.
 *
 * STRUCTURAL SPILLOVER: one Edit carries ONE structural op, but a selector group can hold
 * several (insert two children, move-then-remove). The FIRST structural event folds into
 * `folded`; every ADDITIONAL one becomes its own auto-recorded Edit in `spillover` (never
 * silently dropped — a dropped op would ship a changeset that can't reconstruct the page).
 * Groups are keyed by selector, so the caller canNOT pre-split these; the split must happen
 * here. Spillover edits carry only the structural delta + the group's hint union, plus the model
 * edit's `breakpoint` when set (the spillover ops ran under the same device emulation).
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
  // Heal the selector to ground truth (see the header): the first event's selector is the one
  // that resolved on the page.
  const groupSelector = events[0]?.selector ?? edit.selector;

  const folded: Edit = {
    ...edit,
    selector: groupSelector,
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
      // The spillover ops ran under the same device emulation as the model's edit.
      ...(edit.breakpoint !== undefined ? { breakpoint: edit.breakpoint } : {}),
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

/** `attrs`: per name, FIRST before + LAST after; no-op pairs dropped. `class` is SKIPPED — the
 *  classes family (the window diff below) is the canonical record of a class change, so an attr
 *  entry would contradict it. */
function mergeAttrChanges(events: readonly MutationEvent[]): { merged: AttrChange[] } | undefined {
  let saw = false;
  const byName = new Map<string, { before: string | null; after: string | null }>();
  for (const event of events) {
    const ac = event.attrChange;
    if (!ac || ac.name === 'class') continue;
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
