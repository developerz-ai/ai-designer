import type { ContentToSw, SwToPanel } from './messages';

// Pure content -> panel relay mapping. Lives in src/shared (NOT the
// coverage-excluded service-worker entrypoint) so every branch is unit-testable.
// Returns the SwToPanel message the SW should forward to the panel, or null when
// the event carries nothing to forward (an element-picked with no candidates).
export function relayToPanel(msg: ContentToSw): SwToPanel | null {
  switch (msg.type) {
    case 'element-picked': {
      const first = msg.candidates[0];
      return first ? { type: 'focus', selector: first, rect: msg.rect } : null;
    }
    case 'picker-state':
      return { type: 'picker-state', active: msg.active };
    // `multi-select-changed` + `recorder-event` are consumed SW-side only (the on-page overlay
    // highlight and the session Changeset fold, respectively) — no panel store reflects them, so
    // there is nothing to relay to the panel here.
    default:
      return null;
  }
}
