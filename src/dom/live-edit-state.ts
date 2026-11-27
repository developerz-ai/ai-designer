import { createMutator, type Mutator } from './mutate';
import { createRecorder, type Recorder, type RecorderEmit } from './recorder';

// The page's live edits, kept across a content-script TAKEOVER. background.ts re-injects the content
// script into every open tab on every service-worker boot (and an MV3 worker idles out after ~30s),
// and content.ts's newest instance tears the previous one down. Listeners and UI belong to the
// instance and are rebuilt; the live edits must not be. A fresh mutator reuses the page's overrides
// sheet and rebuilds it from its own EMPTY map, so the first edit after an idle wiped every earlier
// one, and a fresh recorder forgot the undo log the service worker still expects to drive.
//
// So the mutator + recorder live on the isolated world's `window` (per-frame, invisible to the
// page) and the newest instance adopts them. The recorder emits through an indirection that each
// adopter re-points at its own `emit`, so events never go through a torn-down instance.

export interface LiveEditState {
  readonly mutator: Mutator;
  readonly recorder: Recorder;
}

interface HeldLiveEditState extends LiveEditState {
  emit: RecorderEmit;
}

/** Where the state is kept — the content script passes its isolated-world `window`. */
export interface LiveEditHolder {
  __dzDesignerLiveEdits?: HeldLiveEditState;
}

/** Adopt the live edits a previous instance left on `holder`, or create them on first injection.
 *  Either way, recorder events from now on go to `emit`. */
export function adoptLiveEditState(
  holder: LiveEditHolder,
  emit: RecorderEmit,
  doc: Document = document,
): LiveEditState {
  const held = holder.__dzDesignerLiveEdits;
  if (held) {
    held.emit = emit;
    return held;
  }
  const state: HeldLiveEditState = {
    emit,
    mutator: createMutator(doc),
    recorder: createRecorder((msg) => state.emit(msg)),
  };
  holder.__dzDesignerLiveEdits = state;
  return state;
}
