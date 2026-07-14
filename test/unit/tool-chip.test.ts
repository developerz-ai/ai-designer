import { describe, expect, it } from 'vitest';
import {
  toolChipKindLabel,
  toolChipStatus,
  toolChipStatusIcon,
} from '@/entrypoints/sidepanel/components/chat/ToolChip';

// ToolChip's rendering contract exercised through its pure building blocks — mirrors
// icon.test.ts's buildIconSvg/buildIconClass coverage style (CLAUDE.md "no business logic in
// components": the mapping tables are what actually matters, not the JSX around them).

describe('toolChipStatus', () => {
  it('defaults to "done" when the store has not carried a status (its current contract)', () => {
    expect(toolChipStatus(undefined)).toBe('done');
  });

  it.each([
    'running',
    'done',
    'error',
  ] as const)('passes an explicit status "%s" straight through', (status) => {
    expect(toolChipStatus(status)).toBe(status);
  });
});

describe('toolChipStatusIcon', () => {
  it.each([
    ['running', 'spinner'],
    ['done', 'check'],
    ['error', 'warning'],
  ] as const)('maps status "%s" to icon "%s"', (status, icon) => {
    expect(toolChipStatusIcon(status)).toBe(icon);
  });
});

describe('toolChipKindLabel', () => {
  it('is undefined when no kind is given — the badge stays hidden', () => {
    expect(toolChipKindLabel(undefined)).toBeUndefined();
  });

  it.each([
    ['read', 'read'],
    ['act', 'act'],
    ['info', 'info'],
  ] as const)('labels kind "%s" as "%s"', (kind, label) => {
    expect(toolChipKindLabel(kind)).toBe(label);
  });
});
