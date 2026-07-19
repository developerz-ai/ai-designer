import { describe, expect, it } from 'vitest';
import { formatTokens } from '@/entrypoints/sidepanel/components/UsageMeter';

// UsageMeter's contract exercised through its pure token formatter — mirrors tool-chip.test.ts's
// building-block style (CLAUDE.md "no business logic in components": the formatting is what matters,
// not the JSX around it). The visibility gate + wiring are covered by chat-panel-store.test.ts.

describe('formatTokens (#25 usage meter)', () => {
  it('shows the raw integer below a thousand', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(999)).toBe('999');
  });

  it('compacts to a one-decimal "k" at a thousand and above', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(12400)).toBe('12.4k');
    expect(formatTokens(203912)).toBe('203.9k');
  });
});
