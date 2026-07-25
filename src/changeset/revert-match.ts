// Late-revert retraction match + surgical strip (#9 review rounds 2 + 4) — the durable-record
// half of `recorder-revert`. The content recorder's undo emits a revert for a mutation whose event
// is USUALLY still in the SW's pending buffer (pending-mutations.ts `remove` drops it there).
// But once `recordEdit` has drained the event (or turn-end auto-finalize folded it), the
// buffer answer comes back false and the change — already reverted on the page — would ship
// as a phantom edit. background.ts then routes a `{kind:'retract', event}` through the same
// applyChangesetOp machinery the Diff-tab curation RPCs use, which matches + strips in ONE load
// (no double-load TOCTOU): findLastMatchingEditIndex finds the edit, stripEventFromEdit removes
// ONLY the reverted event's contribution, and an all-empty result removes the edit outright.
//
// "Consistent" = SAME selector value + kind-consistent payload. Selector equality is safe to
// require: every edit a drained event can become carries that event's own selector (the fold
// heals a paraphrased selector to `events[0].selector`; auto-finalize records the group's
// selector), so the requirement can only exclude same-kind edits on OTHER elements — never
// the true phantom. Kind consistency maps each mutation kind to the Edit field its fold
// populates — including the class mirror: the fold routes a setAttr('class') into `classes`,
// so the matcher looks there too (round-3 blind spot). LAST match wins: the recorder unwinds
// LIFO, so the newest consistent edit is the one the revert killed.
//
// Pure by construction: no `chrome.*`, no clock. Unit-tested directly.

import type { Edit } from '@/shared/changeset';
import type { MutationEvent } from '@/shared/messages';

/** Whether `edit` could be the durable record of the reverted `event` (see module header). */
function isConsistent(edit: Edit, event: MutationEvent): boolean {
  if (edit.selector.value !== event.selector.value) return false;
  switch (event.kind) {
    case 'setStyle': {
      // Ground-truth producers stamp styleChanges; a pre-#9 event carries none, so any
      // style-bearing edit on the element is consistent (no finer signal survives).
      const props = event.styleChanges?.map((sc) => sc.prop) ?? [];
      if (props.length === 0) return edit.changes.length > 0;
      return edit.changes.some((change) => props.includes(change.prop));
    }
    case 'setAttr': {
      const ac = event.attrChange;
      if (ac === undefined) return false; // a pre-#9 raw setAttr carries no matchable signal
      // The fold routes a setAttr('class') into the classes family, NOT attrs (fold-mutations.ts
      // mergeAttrChanges skips it) — mirror that, else a wholesale class rewrite's revert never
      // matches the edit its fold produced.
      if (ac.name === 'class') return edit.classes.length > 0;
      return edit.attrs.some((attr) => attr.name === ac.name);
    }
    case 'addClass':
    case 'removeClass':
      return (
        event.classChange !== undefined &&
        edit.classes.some((cls) => cls.name === event.classChange?.name)
      );
    case 'setText':
      return edit.text !== undefined;
    case 'insertNode':
    case 'moveNode':
    case 'removeNode':
      return edit.structural !== undefined;
  }
}

/** The index of the LAST edit consistent with the reverted event, or -1 when none matches. */
export function findLastMatchingEditIndex(edits: readonly Edit[], event: MutationEvent): number {
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    if (edit && isConsistent(edit, event)) return i;
  }
  return -1;
}

// --- surgical strip (#9 review round 4) --------------------------------------
// Retracting used to REMOVE the whole matched edit — but a fold can merge several mutations
// into one edit, so one revert killed unrelated families the page still carries. The strip
// removes ONLY the reverted event's contribution, family by family, and never touches `intent`,
// `selector`, `frameworkHints`, `breakpoint`, or `screenshots`.

/** Strip ONLY the reverted event's contribution from a matched edit (the caller matches with
 *  {@link findLastMatchingEditIndex} first). Returns the stripped edit, or null when every
 *  family is empty (changes/attrs/classes all [], no text, no structural) ⇒ the caller removes
 *  the edit outright. Never mutates `edit` — the store treats edits immutably. */
export function stripEventFromEdit(edit: Edit, event: MutationEvent): Edit | null {
  switch (event.kind) {
    case 'setStyle': {
      const changes = edit.changes.flatMap((entry) => {
        // A pre-#9 event carries no styleChanges, so every entry is a candidate whose "revert
        // delta" is the entry itself — restoring it always collapses the pair (the old
        // whole-edit removal, scoped to the family).
        const sc = event.styleChanges
          ? event.styleChanges.find((c) => c.prop === entry.prop)
          : entry;
        if (!sc || entry.after !== sc.after) return [entry]; // not the value this revert set
        // sc.before === null ⇒ the prop was ABSENT before: the pair dies (StyleChange.after is
        // non-nullable, so a null restore can't be represented). sc.before === entry.before ⇒
        // restoring lands exactly on the edit's original: no net change ⇒ the pair dies.
        if (sc.before === null || sc.before === entry.before) return [];
        return [{ ...entry, after: sc.before }];
      });
      return finalize({ ...edit, changes });
    }
    case 'setAttr': {
      const ac = event.attrChange;
      if (!ac) return finalize(edit); // a pre-#9 raw setAttr never matched (see isConsistent)
      if (ac.name === 'class') {
        // A wholesale class rewrite's revert invalidates the window computation that produced
        // `classes` (fold-mutations.ts): the drained events the window was diffed over are gone,
        // so which names the rewrite contributed can no longer be reconstructed. The ENTIRE
        // classes family is stripped. Approximation: unrelated class deltas folded into the same
        // edit go with it — the truthful partial answer needs data the durable record doesn't keep.
        return finalize({ ...edit, classes: [] });
      }
      const attrs = edit.attrs.flatMap((entry) => {
        if (entry.name !== ac.name || entry.after !== ac.after) return [entry];
        // Restore the pre-mutation value (nullable — an absent attribute IS representable on
        // AttrChange); the pair dies when nothing net remains (both null included).
        if (entry.before === ac.before) return [];
        return [{ ...entry, after: ac.before }];
      });
      return finalize({ ...edit, attrs });
    }
    case 'addClass':
    case 'removeClass': {
      const cc = event.classChange;
      if (!cc) return finalize(edit); // a pre-#9 raw class op never matched (see isConsistent)
      // The revert restores the prior class state, so the recorded {name, op} entry dies —
      // matched by NAME: the fold's window diff records the NET effect, and reverting the op
      // that produced it undoes that net whichever op was recorded.
      const classes = edit.classes.filter((cls) => cls.name !== cc.name);
      return finalize({ ...edit, classes });
    }
    case 'setText': {
      const tc = event.textChange;
      const text = edit.text;
      if (!tc || !text || text.after !== tc.after) return finalize(edit);
      if (text.before === tc.before) {
        // Restored all the way to the original ⇒ no net change ⇒ the family dies.
        const { text: _text, ...stripped } = edit;
        return finalize(stripped);
      }
      return finalize({ ...edit, text: { ...text, after: tc.before } });
    }
    case 'insertNode':
    case 'moveNode':
    case 'removeNode': {
      // One edit carries ONE structural op — reverting it voids the whole family.
      const { structural: _structural, ...stripped } = edit;
      return finalize(stripped);
    }
  }
}

/** The strip result: null when NOTHING the edit recorded remains — the caller then removes the
 *  edit outright (same end state as the old whole-edit retraction). */
function finalize(edit: Edit): Edit | null {
  const empty =
    edit.changes.length === 0 &&
    edit.attrs.length === 0 &&
    edit.classes.length === 0 &&
    edit.text === undefined &&
    edit.structural === undefined;
  return empty ? null : edit;
}
