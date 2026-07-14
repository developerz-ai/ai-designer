import { describe, expect, it } from 'vitest';
import { describeSelector } from '@/entrypoints/sidepanel/components/chat/ContextChip';
import type { StableSelector } from '@/shared/changeset';

// Pure label formatting behind ContextChip's pin — no DOM/Solid mount needed.
describe('describeSelector', () => {
  it('formats a short value with its strategy', () => {
    const sel: StableSelector = { value: '#hero', strategy: 'id', fragile: false };
    expect(describeSelector(sel)).toBe('#hero · id');
  });

  it('truncates a value longer than maxLength', () => {
    const sel: StableSelector = {
      value: 'body > div.a > div.b > div.c > div.d > div.e > span',
      strategy: 'css-path',
      fragile: true,
    };
    const result = describeSelector(sel, 20);
    expect(result.startsWith('body > div.a')).toBe(true);
    expect(result).toContain('…');
    expect(result.endsWith('· css path')).toBe(true);
  });

  it('leaves a value at exactly maxLength untouched', () => {
    const sel: StableSelector = { value: '12345', strategy: 'text', fragile: false };
    expect(describeSelector(sel, 5)).toBe('12345 · text');
  });

  // The remaining strategies — every label ContextChip's pin can actually show (task #70's
  // "render states" ask), rounding out the id/css-path/text coverage above.
  it.each([
    ['data-attr', '[data-testid="cta"]', 'data attr'],
    ['aria', 'role=button[name="Buy now"]', 'aria'],
    ['shadow', 'my-widget >>> .inner', 'shadow'],
  ] as const)('labels strategy "%s"', (strategy, value, label) => {
    const sel: StableSelector = { value, strategy, fragile: false };
    expect(describeSelector(sel)).toBe(`${value} · ${label}`);
  });
});
