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
    // Shift-multi-select (#165 S7): relayed as `focus-multi`, the multi-element sibling of
    // `focus`, so the composer can chip the selection and echo it back on the next
    // `UserMessage.selectors` — the grounding half of "make THESE bigger". An EMPTY array is
    // relayed too: it means the user cleared the selection, which the panel must reflect.
    // (Before #165 this returned null under a comment claiming an on-page overlay consumed it
    // SW-side; no such path existed — the event was emitted and read by nothing.)
    case 'multi-select-changed':
      return { type: 'focus-multi', selectors: msg.selectors };
    // `recorder-event` / `recorder-revert` / `diagnostics-signal` are consumed SW-side only (the
    // Changeset fold, the revert retraction, the diagnostics buffer) — no panel store reflects
    // them, so there is nothing to relay here.
    default:
      return null;
  }
}
