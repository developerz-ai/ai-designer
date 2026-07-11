import { describe, expect, it } from 'vitest';
import { type FocusState, reduceFocus } from '@/entrypoints/sidepanel/stores/focus';

const selector = { value: '[data-testid="cta"]', strategy: 'data-attr' as const, fragile: false };
const rect = { x: 10, y: 20, width: 100, height: 50 };
const initial: FocusState = { selector: null, rect: null, pickerActive: false };

describe('reduceFocus', () => {
  it('focus sets selector and rect', () => {
    expect(reduceFocus(initial, { type: 'focus', selector, rect })).toEqual({
      selector,
      rect,
      pickerActive: false,
    });
  });

  it('picker-state active sets pickerActive true', () => {
    expect(reduceFocus(initial, { type: 'picker-state', active: true })).toEqual({
      selector: null,
      rect: null,
      pickerActive: true,
    });
  });

  it('picker-state inactive clears selector and rect', () => {
    const focused: FocusState = { selector, rect, pickerActive: true };
    expect(reduceFocus(focused, { type: 'picker-state', active: false })).toEqual({
      selector: null,
      rect: null,
      pickerActive: false,
    });
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
