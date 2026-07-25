import { describe, expect, it } from 'vitest';
import { CLEAR_CONFIRM_MS, clearClick } from '@/entrypoints/sidepanel/components/ChangesetPreview';

// ChangesetPreview unit (#142): the two-click clear-session confirm as a pure seam (mirrors
// readiness-dropdown.test.ts's `sessionButton` coverage). Clear wipes the record AND the redo
// stack, irreversibly, one click away from undo/redo — so a single stray click must only ARM,
// never fire. The component owns the timer/pointer-leave disarm around this step.
describe('clearClick (two-click clear-session confirm)', () => {
  it('the first click ARMS without firing', () => {
    expect(clearClick(false)).toEqual({ fire: false, armed: true });
  });

  it('a click while armed FIRES and returns to idle', () => {
    expect(clearClick(true)).toEqual({ fire: true, armed: false });
  });

  it('the auto-disarm window is a few seconds, not a trap', () => {
    expect(CLEAR_CONFIRM_MS).toBeGreaterThanOrEqual(2000);
    expect(CLEAR_CONFIRM_MS).toBeLessThanOrEqual(10_000);
  });
});
