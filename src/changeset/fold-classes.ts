// The class-window machinery of the recordEdit fold (split out of fold-mutations.ts, #142, to
// keep each module under the 200-LOC budget). `mergeClassChanges` computes an edit's durable
// `classes` delta from a drained selector group's recorder events: an exact WINDOW set-diff over
// the classAttr strings, intersected with the events' typed class names so page churn isn't
// attributed to the agent. Pure by construction: no `chrome.*`, no clock. Unit-tested via
// test/unit/pending-mutations.test.ts (through `foldMutationEvents`).

import type { ClassChange } from '@/shared/changeset';
import type { MutationEvent } from '@/shared/messages';

/** `classes`: an exact WINDOW set-diff, NOT op parity — loss-immune, attribution-filtered.
 *  Class-relevant events = events with a `classChange` OR an `attrChange.name === 'class'` (a
 *  setAttr('class') rewrites the whole class list and must feed the same family). For a class-op
 *  event the full classAttr strings are `event.before` / `event.after`; for a setAttr('class')
 *  event they are `attrChange.before` / `attrChange.after` (null ⇒ ''). The window is the FIRST
 *  class-relevant event's before-classAttr and the LAST's after-classAttr; the net per name is
 *  the plain set difference. A diff loses nothing to an interleave — a setAttr('class') in the
 *  middle, or page JS churning the class list between tool calls (parity read a churn-shaped
 *  [add, add] as a canceled pair and dropped a REAL net add) — but loss-immunity alone would
 *  ATTRIBUTE the page's churn to the agent: a name the page added mid-window nets `add` in the
 *  diff with no tool call behind it. So the net is INTERSECTED with the events' typed class
 *  names (see {@link attributedClassNames}). The intersect ALWAYS runs: class-relevance is
 *  defined by carrying typed data, so every relevant event feeds the union — a raw pre-#9 group
 *  has NO class-relevant event and hits the `undefined` early return instead (family untouched:
 *  the model's classes stand, the back-compat path). Returns `{ merged: [] }` when nothing net
 *  survives — either the events net nothing, or the churn filter dropped every name
 *  (ground-truth "no agent change" — replaces the model's classes). */
export function mergeClassChanges(
  events: readonly MutationEvent[],
): { merged: ClassChange[] } | undefined {
  const relevant = events.filter(
    (e) => e.classChange !== undefined || e.attrChange?.name === 'class',
  );
  const first = relevant[0];
  const last = relevant[relevant.length - 1];
  if (!first || !last) return undefined;
  const beforeNames = splitClasses(classAttrOf(first, 'before'));
  const afterNames = splitClasses(classAttrOf(last, 'after'));
  const beforeSet = new Set(beforeNames);
  const afterSet = new Set(afterNames);
  // The attribution filter: names the AGENT actually drove. Always defined here (see the
  // docblock) — an event is class-relevant only by carrying the typed data the union reads.
  const attributed = attributedClassNames(relevant);
  // Stable order: first-appearance in the after string (adds), then in the before string
  // (removes). The strings are split + deduped above, so iteration is already first-appearance.
  const merged: ClassChange[] = [];
  for (const name of afterNames) {
    if (beforeSet.has(name)) continue;
    if (!attributed.has(name)) continue; // page churn, not the agent's
    merged.push({ name, op: 'add' });
  }
  for (const name of beforeNames) {
    if (afterSet.has(name)) continue;
    if (!attributed.has(name)) continue; // page churn, not the agent's
    merged.push({ name, op: 'remove' });
  }
  return { merged };
}

/** The union of typed class names over class-relevant events — `classChange.name` over the
 *  class-op events PLUS, for setAttr('class') events, the tokens of `attrChange.before` ∪
 *  `attrChange.after` (a wholesale rewrite's full old/new lists ARE agent-attributed). Never
 *  undefined at the {@link mergeClassChanges} call site: an event is class-relevant only by
 *  carrying exactly this typed data, so the "no typed data" skip-intersect branch the raw
 *  pre-#9 back-compat once needed is unreachable here — that path is the empty-`relevant`
 *  early return above. */
function attributedClassNames(relevant: readonly MutationEvent[]): Set<string> {
  const names = new Set<string>();
  for (const event of relevant) {
    if (event.classChange) names.add(event.classChange.name);
    const ac = event.attrChange;
    if (ac?.name === 'class') {
      for (const name of splitClasses(ac.before ?? '')) names.add(name);
      for (const name of splitClasses(ac.after ?? '')) names.add(name);
    }
  }
  return names;
}

/** The full classAttr string carried by one class-relevant event. setAttr('class') self-describes
 *  (its opaque `event.before`/`after` are JSON), so read the typed attrChange sides; a class-op
 *  event's opaque before/after ARE the classAttr strings. */
function classAttrOf(event: MutationEvent, side: 'before' | 'after'): string {
  const ac = event.attrChange;
  if (ac?.name === 'class') return ac[side] ?? '';
  return event[side];
}

/** classAttr string -> class names, whitespace-split, first-appearance order, deduped. */
function splitClasses(value: string): string[] {
  return [...new Set(value.split(/\s+/).filter(Boolean))];
}
