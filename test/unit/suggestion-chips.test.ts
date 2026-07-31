import { describe, expect, it } from 'vitest';
import { SUGGESTIONS } from '@/entrypoints/sidepanel/components/chat/SuggestionChips';
import { ICON_NAMES } from '@/entrypoints/sidepanel/components/icon-registry';

// The fixed task-chip set EmptyState surfaces before any turn has run (docs/plans task #68).
// The rendered rows — one control per suggestion, dispatching the suggestion object — are
// covered by empty-state.test.tsx; this file guards the data.
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

  // Leo's rows carry a leading glyph (#165). The field is optional on the type, but an
  // unregistered name would throw at render time rather than fall back — so pin it here instead
  // of discovering it in the panel.
  it('gives every chip a registered leading icon', () => {
    for (const s of SUGGESTIONS) {
      expect(s.icon).toBeDefined();
      expect(ICON_NAMES).toContain(s.icon);
    }
  });
});
