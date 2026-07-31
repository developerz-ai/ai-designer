import { describe, expect, it } from 'vitest';
import { type FocusState, reduceFocus } from '@/entrypoints/sidepanel/stores/focus';

const selector = { value: '[data-testid="cta"]', strategy: 'data-attr' as const, fragile: false };
const other = { value: '#hero', strategy: 'id' as const, fragile: false };
const rect = { x: 10, y: 20, width: 100, height: 50 };
const initial: FocusState = { selector: null, rect: null, pickerActive: false, selectors: [] };

describe('reduceFocus', () => {
  it('focus sets selector and rect', () => {
    expect(reduceFocus(initial, { type: 'focus', selector, rect })).toEqual({
      selector,
      rect,
      pickerActive: false,
      selectors: [],
    });
  });

  it('picker-state active sets pickerActive true', () => {
    expect(reduceFocus(initial, { type: 'picker-state', active: true })).toEqual({
      selector: null,
      rect: null,
      pickerActive: true,
      selectors: [],
    });
  });

  it('picker-state inactive ends the picker but KEEPS the pick', () => {
    // src/dom/picker.ts doesn't stop after a pick, so Escape ("I'm done picking") is what emits
    // this — and it used to throw away the element the user had just pinned.
    const focused: FocusState = { selector, rect, pickerActive: true, selectors: [] };
    expect(reduceFocus(focused, { type: 'picker-state', active: false })).toEqual({
      selector,
      rect,
      pickerActive: false,
      selectors: [],
    });
  });

  it('focus-multi adopts the shift-multi-select set', () => {
    expect(reduceFocus(initial, { type: 'focus-multi', selectors: [selector, other] })).toEqual({
      selector: null,
      rect: null,
      pickerActive: false,
      selectors: [selector, other],
    });
  });

  it('an EMPTY focus-multi means the user cleared it — the chips go', () => {
    const many: FocusState = { ...initial, selectors: [selector, other] };
    expect(reduceFocus(many, { type: 'focus-multi', selectors: [] }).selectors).toEqual([]);
  });

  it('ignores unrelated messages', () => {
    const tokenMsg = { type: 'token', text: 'hi' } as Parameters<typeof reduceFocus>[1];
    expect(reduceFocus(initial, tokenMsg)).toBe(initial);
  });

  it('is pure / does not mutate input', () => {
    reduceFocus(initial, { type: 'focus', selector, rect });
    expect(initial.selector).toBeNull();
    expect(initial.rect).toBeNull();
  });
});
