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
    case 'multi-select-changed':
      // The picker's shift-click set → the panel's multi-select highlight (empty list clears it).
      return { type: 'multi-select', selectors: msg.selectors };
    case 'recorder-event':
      // A live reversible mutation → the panel (edit chip). The SW separately folds these into
      // the session Changeset (slice 07); relay only mirrors the stream to the panel.
      return { type: 'recorder-event', event: msg.event };
    default:
      return null;
  }
}
