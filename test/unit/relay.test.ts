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

  it('does not relay multi-select-changed to the panel (no panel consumer — SW/overlay only)', () => {
    expect(relayToPanel({ type: 'multi-select-changed', selectors: [selector] })).toBeNull();
    expect(relayToPanel({ type: 'multi-select-changed', selectors: [] })).toBeNull();
  });

  it('does not relay recorder-event to the panel (SW folds it into the Changeset)', () => {
    const event = { kind: 'setStyle' as const, selector, before: '', after: 'x', ts: 0 };
    expect(relayToPanel({ type: 'recorder-event', event })).toBeNull();
  });
});
