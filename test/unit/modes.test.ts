import { describe, expect, it } from 'vitest';
import { inferMode, modeGuidance, resolveMode } from '@/agent/modes';

// modes.ts unit: the copy/debug mode selection (plan 06 "modes selection" test). `inferMode` is
// a pure keyword heuristic over free text, `resolveMode` layers an explicit choice on top of it,
// and `modeGuidance` maps a resolved mode to the prompt addendum + tool emphasis the loop feeds
// into `buildSystemPrompt`. No chrome.*, deterministic — same input, same output.

describe('inferMode', () => {
  it('infers debug from debug-flavored instructions', () => {
    expect(inferMode('debug my checkout flow')).toBe('debug');
    expect(inferMode('the submit button is broken')).toBe('debug');
    expect(inferMode('why is the modal not closing')).toBe('debug');
    expect(inferMode("the form doesn't work on mobile")).toBe('debug');
    expect(inferMode('there is a console error on load')).toBe('debug');
  });

  it('infers copy from copy/design-flavored instructions', () => {
    expect(inferMode('make my site look like nvidia.com')).toBe('copy');
    expect(inferMode('copy the hero section from stripe')).toBe('copy');
    expect(inferMode('give me some design ideas inspired by linear')).toBe('copy');
    expect(inferMode('match the style of our competitor')).toBe('copy');
  });

  it('is case-insensitive', () => {
    expect(inferMode('DEBUG the pricing page')).toBe('debug');
    expect(inferMode('CLONE the reference site')).toBe('copy');
  });

  it('returns undefined for a generic edit with no mode vocabulary', () => {
    expect(inferMode('make the CTA button orange')).toBeUndefined();
    expect(inferMode('')).toBeUndefined();
  });

  it('prefers debug when both vocabularies appear — a debug-mode miss is the more consequential one', () => {
    expect(inferMode('debug why my page does not look like the competitor')).toBe('debug');
  });
});

describe('resolveMode', () => {
  it('an explicit mode always wins over inference', () => {
    expect(resolveMode('copy', 'debug this broken button')).toBe('copy');
    expect(resolveMode('debug', 'copy the reference site')).toBe('debug');
  });

  it('falls back to inference when no explicit mode is given', () => {
    expect(resolveMode(undefined, 'debug my checkout flow')).toBe('debug');
    expect(resolveMode(undefined, 'copy nvidia')).toBe('copy');
  });

  it('resolves to undefined when neither an explicit mode nor the text carries one', () => {
    expect(resolveMode(undefined, 'make the CTA button orange')).toBeUndefined();
  });
});

describe('modeGuidance', () => {
  it('copy mode returns a `modes`-section addendum and browse-first tool emphasis', () => {
    const addenda = modeGuidance('copy').addenda ?? {};
    expect(addenda.modes).toHaveLength(1);
    expect(addenda.modes?.[0]).toMatch(/copy\/design task/i);
    expect(addenda.modes?.[0]).toContain('browse');
    expect(addenda.modes?.[0]).toContain('extractIdentity');
    expect(addenda.modes?.[0]).toMatch(/apply that identity's palette and type/i);
    expect(addenda.modes?.[0]).toMatch(/prefer `describe` over a `screenshot`/i);
    expect(modeGuidance('copy').toolEmphasis).toEqual([
      'browse',
      'extractIdentity',
      'describe',
      'query',
      'getStyles',
      'a11ySnapshot',
      'setStyle',
      'setText',
    ]);
  });

  it('debug mode returns a `modes`-section addendum and diagnostics-first tool emphasis', () => {
    const addenda = modeGuidance('debug').addenda ?? {};
    expect(addenda.modes).toHaveLength(1);
    expect(addenda.modes?.[0]).toMatch(/debug task/i);
    expect(addenda.modes?.[0]).toMatch(/observe.*hypothesize.*reproduce/is);
    expect(modeGuidance('debug').toolEmphasis[0]).toBe('diagnostics');
  });

  it('undefined mode returns no addendum and no tool emphasis (the base MODES section already covers it)', () => {
    const guidance = modeGuidance(undefined);
    expect(guidance.addenda).toEqual({});
    expect(guidance.toolEmphasis).toEqual([]);
  });

  it('addenda only ever populate the `modes` prompt section', () => {
    for (const mode of ['copy', 'debug'] as const) {
      expect(Object.keys(modeGuidance(mode).addenda ?? {})).toEqual(['modes']);
    }
  });
});
