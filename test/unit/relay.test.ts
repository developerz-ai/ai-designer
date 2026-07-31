import { describe, expect, it } from 'vitest';
import type { ContentToSw } from '@/shared/messages';
import { relayToPanel } from '@/shared/relay';

const selector = { value: '[data-testid="cta"]', strategy: 'data-attr' as const, fragile: false };
const rect = { x: 1, y: 2, width: 3, height: 4 };

describe('relayToPanel', () => {
  it('maps element-picked to a focus message using the top candidate', () => {
    const msg: ContentToSw = { type: 'element-picked', candidates: [selector], rect };
    expect(relayToPanel(msg)).toEqual({ type: 'focus', selector, rect });
  });

  it('drops element-picked with no candidates', () => {
    const msg: ContentToSw = { type: 'element-picked', candidates: [], rect };
    expect(relayToPanel(msg)).toBeNull();
  });

  it('passes picker-state through', () => {
    expect(relayToPanel({ type: 'picker-state', active: true })).toEqual({
      type: 'picker-state',
      active: true,
    });
  });

  // #165 S7: this used to return null under a comment claiming an on-page overlay consumed the
  // event SW-side. No such path existed — shift-multi-select painted green boxes and did nothing.
  it('relays multi-select-changed as focus-multi so the composer can chip the selection', () => {
    const second = { value: '#hero', strategy: 'id' as const, fragile: false };
    expect(relayToPanel({ type: 'multi-select-changed', selectors: [selector, second] })).toEqual({
      type: 'focus-multi',
      selectors: [selector, second],
    });
  });

  it('relays an EMPTY multi-select as focus-multi — a cleared selection the panel must reflect', () => {
    expect(relayToPanel({ type: 'multi-select-changed', selectors: [] })).toEqual({
      type: 'focus-multi',
      selectors: [],
    });
  });

  it('does not relay recorder-revert / diagnostics-signal (SW-side engine inputs)', () => {
    const event = { kind: 'setStyle' as const, selector, before: '', after: 'x', ts: 0 };
    expect(relayToPanel({ type: 'recorder-revert', event })).toBeNull();
    expect(
      relayToPanel({
        type: 'diagnostics-signal',
        signal: { kind: 'exception', message: 'boom', ts: 0 },
      }),
    ).toBeNull();
  });

  it('does not relay recorder-event to the panel (SW folds it into the Changeset)', () => {
    const event = { kind: 'setStyle' as const, selector, before: '', after: 'x', ts: 0 };
    expect(relayToPanel({ type: 'recorder-event', event })).toBeNull();
  });
});
