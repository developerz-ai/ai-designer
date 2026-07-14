import type { ElementMutation } from '@/dom/mutate';
import type { ContentToSw, MutationEvent, StableSelector } from '@/shared/messages';

// Changeset recorder — the content script's edit log. Every reversible mutation the agent applies
// (src/dom/mutate.ts) is recorded here: the recorder projects it to a serializable MutationEvent
// (messages.ts) by stamping the target's stable selector + a timestamp, pushes the invertible
// mutation onto an undo stack, and emits a `recorder-event` over the bus so the SW can fold it
// into the session Changeset (slice 07). `undo` pops LIFO and reverses the real DOM change.
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

export interface Recorder {
  /** Record an applied mutation against `selector`: emits `recorder-event`, stacks the undo,
   *  and returns the emitted event. */
  record(selector: StableSelector, mutation: ElementMutation): MutationEvent;
  /** Reverse the most recent recorded mutation (LIFO), returning its event — or `null` when the
   *  log is empty. Reverses the exact DOM change via the mutation's own `undo()`. */
  undo(): MutationEvent | null;
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

  function record(selector: StableSelector, mutation: ElementMutation): MutationEvent {
    const event: MutationEvent = {
      kind: mutation.kind,
      selector,
      before: mutation.before,
      after: mutation.after,
      ts: now(),
      // ruleId is present only for setStyle (its overrides-sheet rule). Spread it in so the
      // field is genuinely absent otherwise, not an explicit `undefined`.
      ...(mutation.ruleId !== undefined ? { ruleId: mutation.ruleId } : {}),
    };
    stack.push({ event, mutation });
    emit({ type: 'recorder-event', event });
    return event;
  }

  function undo(): MutationEvent | null {
    const entry = stack.pop();
    if (!entry) return null;
    entry.mutation.undo();
    return entry.event;
  }

  return {
    record,
    undo,
    size: () => stack.length,
    clear: () => {
      stack.length = 0;
    },
  };
}
