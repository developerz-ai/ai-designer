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

  it('maps multi-select-changed to a multi-select stream event', () => {
    expect(relayToPanel({ type: 'multi-select-changed', selectors: [selector] })).toEqual({
      type: 'multi-select',
      selectors: [selector],
    });
  });

  it('passes an empty multi-selection through (clears the panel highlight)', () => {
    expect(relayToPanel({ type: 'multi-select-changed', selectors: [] })).toEqual({
      type: 'multi-select',
      selectors: [],
    });
  });

  it('mirrors recorder-event to the panel stream', () => {
    const event = { kind: 'setStyle' as const, selector, before: '', after: 'x', ts: 0 };
    expect(relayToPanel({ type: 'recorder-event', event })).toEqual({
      type: 'recorder-event',
      event,
    });
  });
});
