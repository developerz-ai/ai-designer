import { describe, expect, it } from 'vitest';
import {
  editsSummary,
  showMarkdown,
  toolCallStatus,
} from '@/entrypoints/sidepanel/components/chat/Message';

// Message's rendering contract exercised through its pure building blocks (mirrors
// tool-chip.test.ts / icon.test.ts) — role variant, edits pluralization, and the derived
// per-call ToolChip status that gives "ToolChip running -> done" real behavior instead of a
// dead prop (docs/plans task #70).

describe('showMarkdown', () => {
  it('renders assistant text through markdown', () => {
    expect(showMarkdown('assistant')).toBe(true);
  });

  it.each(['user', 'system'] as const)('renders "%s" text as plain text', (role) => {
    expect(showMarkdown(role)).toBe(false);
  });
});

describe('editsSummary', () => {
  it('uses the singular for exactly one edit', () => {
    expect(editsSummary(1)).toBe('1 edit recorded');
  });

  it.each([0, 2, 5])('uses the plural for %i edits', (count) => {
    expect(editsSummary(count)).toBe(`${count} edits recorded`);
  });
});

describe('toolCallStatus', () => {
  it('marks only the most recent call as running while the bubble still streams', () => {
    expect(toolCallStatus(0, 2, true, false)).toBe('done');
    expect(toolCallStatus(1, 2, true, false)).toBe('running');
  });

  it('marks the most recent call as error when the turn ended in one', () => {
    expect(toolCallStatus(1, 2, false, true)).toBe('error');
  });

  it('error takes priority over a still-streaming flag on the last call', () => {
    expect(toolCallStatus(1, 2, true, true)).toBe('error');
  });

  it('settles to done once streaming ends without error', () => {
    expect(toolCallStatus(1, 2, false, false)).toBe('done');
  });

  it('a single call follows the same last-index rule as any other', () => {
    expect(toolCallStatus(0, 1, true, false)).toBe('running');
    expect(toolCallStatus(0, 1, false, false)).toBe('done');
  });

  it('never marks an earlier, already-completed call as running or error', () => {
    expect(toolCallStatus(0, 3, true, true)).toBe('done');
  });
});
