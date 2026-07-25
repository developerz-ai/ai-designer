import type { ElementMutation } from '@/dom/mutate';
import type { StructuralChange } from '@/shared/changeset';
import type { ContentToSw, MutationEvent, StableSelector } from '@/shared/messages';

// Changeset recorder — the content script's edit log. Every reversible mutation the agent applies
// (src/dom/mutate.ts) is recorded here: the recorder projects it to a serializable MutationEvent
// (messages.ts) by stamping the target's stable selector + a timestamp, pushes the invertible
// mutation onto an undo stack, and emits a `recorder-event` over the bus so the SW can fold it
// into the session Changeset (slice 07). `undo` pops LIFO and reverses the real DOM change —
// and, on a successful revert, emits a `recorder-revert` so the SW drops the now-untrue event
// from its pending buffer (a reverted change must never reach the durable changeset).
//
// It records at the mutate call site rather than diffing the DOM with a MutationObserver: our
// setStyle writes a stylesheet rule (not an inline attribute) that an observer can't attribute to
// an element, and an observer would also capture the page's own dynamic churn as design edits.
// Recording the mutation object is lossless and ignores our private marker attribute for free.
//
// Pure DOM + injected `emit`/`now` → jsdom-testable; the content entrypoint stays a thin wire.
// See docs/idea/live-edit.md + docs/architecture/changeset.md.

/** Sink for the recorder's `ContentToSw` events. The content script forwards these to the SW. */
export type RecorderEmit = (msg: ContentToSw) => void;

/** Event data the mutation itself can't know (#9): the executor builds these from the tool input
 *  + the resolved target. `structural` describes insertNode/moveNode/removeNode against the
 *  changeset's StructuralChange union; `frameworkHints` is the target's CSS-approach markers
 *  (src/dom/framework-hints.ts), present on EVERY element-targeting event (empty = "detected,
 *  none found" — distinct from absent, which means a pre-#9 producer). */
export interface RecordExtras {
  structural?: StructuralChange;
  frameworkHints?: string[];
}

export interface Recorder {
  /** Record an applied mutation against `selector`: emits `recorder-event`, stacks the undo,
   *  and returns the emitted event. The mutation's own typed fields (#9: styleChanges /
   *  attrChange / classChange / textChange) and the caller's `extras` fold onto the event. */
  record(selector: StableSelector, mutation: ElementMutation, extras?: RecordExtras): MutationEvent;
  /** Reverse the most recent recorded mutation (LIFO), returning its event — or `null` when the
   *  log is empty. Reverses the exact DOM change via the mutation's own `undo()`. A mutation that
   *  FAILS to revert keeps its entry (re-pushed) and throws — see `drop` for the deliberate
   *  escape. A SUCCESSFUL revert also emits `recorder-revert` so the SW drops the buffered event:
   *  the change no longer exists on the page, so it must never fold into the durable changeset. */
  undo(): MutationEvent | null;
  /** Pop the most recent entry WITHOUT reverting it (the `discardUndo` tool's escape for a
   *  permanently churned anchor wedging the LIFO top), returning its event — or `null` when empty. */
  drop(): MutationEvent | null;
  /** Number of undoable mutations currently on the stack. */
  size(): number;
  /** Drop the undo log without reversing anything (e.g. a session reset). */
  clear(): void;
}

interface Entry {
  event: MutationEvent;
  mutation: ElementMutation;
}

/**
 * Build a recorder. `now` is injected (defaults to `Date.now`) so tests can assert deterministic
 * `ts` values; the content script uses the real clock.
 */
export function createRecorder(emit: RecorderEmit, now: () => number = () => Date.now()): Recorder {
  const stack: Entry[] = [];

  function record(
    selector: StableSelector,
    mutation: ElementMutation,
    extras?: RecordExtras,
  ): MutationEvent {
    const event: MutationEvent = {
      kind: mutation.kind,
      selector,
      before: mutation.before,
      after: mutation.after,
      ts: now(),
      // Every optional #9 field spreads in only when present, so it is genuinely absent (not an
      // explicit `undefined`) for producers/kinds that don't carry it — same rule as ruleId.
      // ruleId is present only for setStyle (its overrides-sheet rule).
      ...(mutation.ruleId !== undefined ? { ruleId: mutation.ruleId } : {}),
      ...(mutation.styleChanges ? { styleChanges: mutation.styleChanges } : {}),
      ...(mutation.attrChange ? { attrChange: mutation.attrChange } : {}),
      ...(mutation.classChange ? { classChange: mutation.classChange } : {}),
      ...(mutation.textChange ? { textChange: mutation.textChange } : {}),
      ...(extras?.structural ? { structural: extras.structural } : {}),
      ...(extras?.frameworkHints ? { frameworkHints: extras.frameworkHints } : {}),
    };
    stack.push({ event, mutation });
    emit({ type: 'recorder-event', event });
    return event;
  }

  function undo(): MutationEvent | null {
    const entry = stack.pop();
    if (!entry) return null;
    try {
      entry.mutation.undo();
    } catch (err) {
      // A failed revert (e.g. a structural undo whose anchor the page churned away) must NOT lose
      // the entry: re-push it and throw, so the executor answers with an honest error instead of
      // silently dropping the entry and letting a retry revert something older. The agent decides
      // to retry, `discardUndo`, or move on — the log is never corrupted by a throw.
      stack.push(entry);
      throw err;
    }
    // The revert SUCCEEDED — the mutation no longer exists on the page, so its buffered event
    // must leave the SW's pending buffer (else turn-end would fold a reverted change into the
    // durable changeset: a phantom edit). Only the success path emits: a failed revert kept the
    // change live (its event stays truthful), and `drop()` deliberately does too.
    emit({ type: 'recorder-revert', event: entry.event });
    return entry.event;
  }

  // Pop the top entry WITHOUT reverting it — the deliberate escape when a permanently churned
  // anchor wedges the LIFO top (every undo retries the same failing entry, bricking the older
  // ones). Agent-surface only via the `discardUndo` tool, so the discard is a loud, chosen act —
  // never a silent auto-drop.
  function drop(): MutationEvent | null {
    const entry = stack.pop();
    return entry ? entry.event : null;
  }

  return {
    record,
    undo,
    drop,
    size: () => stack.length,
    clear: () => {
      stack.length = 0;
    },
  };
}
