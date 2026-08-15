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

  // The row now spends its width on the tool name alone (the kind badge went visually-hidden —
  // "screenshot read done" said one useful word in three), so the glyph is the only VISUAL
  // state marker left. Three states, three shapes: if any two collided, a failed call would
  // look like a finished one on screen. The word itself still rides in the accessibility tree
  // (ToolCallList renders it visually-hidden) — shape and colour alone are not a distinction,
  // WCAG 1.4.1.
  it('gives each status a shape of its own, so no two states look alike', () => {
    const icons = (['running', 'done', 'error'] as const).map(toolChipStatusIcon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe('toolChipKindLabel', () => {
  it('is undefined when no kind is given — nothing is rendered for it at all', () => {
    expect(toolChipKindLabel(undefined)).toBeUndefined();
  });

  // The badge no longer shows on screen; the label is now what a screen reader reads for the
  // row's kind, which is exactly why it must stay a real word and not be dropped with the
  // styling. Hidden is not deleted.
  it.each([
    ['read', 'read'],
    ['act', 'act'],
    ['info', 'info'],
  ] as const)('labels kind "%s" as "%s" for assistive tech', (kind, label) => {
    expect(toolChipKindLabel(kind)).toBe(label);
  });
});
