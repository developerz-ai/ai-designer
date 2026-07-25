// Late-revert retraction match (#9 review round 2) — the durable-record half of
// `recorder-revert`. The content recorder's undo emits a revert for a mutation whose event
// is USUALLY still in the SW's pending buffer (pending-mutations.ts `remove` drops it there).
// But once `recordEdit` has drained the event (or turn-end auto-finalize folded it), the
// buffer answer comes back false and the change — already reverted on the page — would ship
// as a phantom edit. background.ts then scans the tab's durable changeset with this pure
// lookup and routes a `{kind:'remove', index}` through the same applyChangesetOp machinery
// the Diff-tab curation RPCs use.
//
// "Consistent" = SAME selector value + kind-consistent payload. Selector equality is safe to
// require: every edit a drained event can become carries that event's own selector (the fold
// heals a paraphrased selector to `events[0].selector`; auto-finalize records the group's
// selector), so the requirement can only exclude same-kind edits on OTHER elements — never
// the true phantom. Kind consistency maps each mutation kind to the Edit field its fold
// populates. LAST match wins: the recorder unwinds LIFO, so the newest consistent edit is
// the one the revert killed.
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
    case 'setAttr':
      return (
        event.attrChange !== undefined &&
        edit.attrs.some((attr) => attr.name === event.attrChange?.name)
      );
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
