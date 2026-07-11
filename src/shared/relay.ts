import type { ContentToSw, SwToPanel } from './messages';

// Pure content -> panel relay mapping. Lives in src/shared (NOT the
// coverage-excluded service-worker entrypoint) so every branch is unit-testable.
// Returns the SwToPanel message the SW should forward to the panel, or null when
// the content event has no panel consumer yet (its consumer lands in a later issue).
export function relayToPanel(msg: ContentToSw): SwToPanel | null {
  switch (msg.type) {
    case 'element-picked': {
      const first = msg.candidates[0];
      return first ? { type: 'focus', selector: first, rect: msg.rect } : null;
    }
    case 'picker-state':
      return { type: 'picker-state', active: msg.active };
    case 'multi-select-changed':
      // TODO: forward to panel (consumer lands in a later issue)
      return null;
    case 'recorder-event':
      // TODO: forward to changeset recorder (consumer lands in a later issue)
      return null;
    default:
      return null;
  }
}
