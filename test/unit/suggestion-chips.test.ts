import { describe, expect, it } from 'vitest';
import { SUGGESTIONS } from '@/entrypoints/sidepanel/components/chat/SuggestionChips';

// The fixed task-chip set EmptyState surfaces before any turn has run (docs/plans task #68).
describe('SUGGESTIONS', () => {
  it('includes the copy/debug/ship starter chips', () => {
    const labels = SUGGESTIONS.map((s) => s.label);
    expect(labels).toEqual(["Copy nvidia's hero", 'Debug this filter', 'Ship to developerz.ai']);
  });

  it('every chip has a non-empty prompt to send', () => {
    for (const s of SUGGESTIONS) {
      expect(s.prompt.trim().length).toBeGreaterThan(0);
    }
  });
});
