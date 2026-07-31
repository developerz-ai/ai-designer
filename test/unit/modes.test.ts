import { describe, expect, it } from 'vitest';
import { inferMode, modeGuidance, resolveMode } from '@/agent/modes';

// modes.ts unit: the copy/debug mode selection (plan 06 "modes selection" test). `inferMode` is
// a pure word-bounded keyword heuristic over free text with session-mode stickiness (#168),
// `resolveMode` layers an explicit choice on top of it, and `modeGuidance` maps a resolved mode
// to a per-turn MESSAGE-TAIL addendum + tool emphasis — never a system-prompt addendum, so the
// system prompt stays byte-stable for prefix caching. No chrome.*, deterministic.

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

  it('matches on word boundaries — keywords inside larger words do not fire (#168)', () => {
    // 'fix' ⊂ "prefix" and 'like' ⊂ "unlike" both fired under the old substring `includes`.
    expect(inferMode('add an icon prefix to every nav item')).toBeUndefined();
    expect(inferMode('this page is unlike the others, keep its layout')).toBeUndefined();
    expect(inferMode('the suffix in the heading looks off')).toBeUndefined();
    // The bare words themselves still fire.
    expect(inferMode('fix the header overlap')).toBe('debug');
    expect(inferMode('I like stripe, make it like that')).toBe('copy');
  });

  it('returns undefined for a generic edit with no mode vocabulary', () => {
    expect(inferMode('make the CTA button orange')).toBeUndefined();
    expect(inferMode('')).toBeUndefined();
  });

  it('prefers debug when both vocabularies appear — a debug-mode miss is the more consequential one', () => {
    expect(inferMode('debug why my page does not look like the competitor')).toBe('debug');
  });

  it('sticks to the previous session mode when the new message carries no keyword (#168)', () => {
    expect(inferMode('now the header too', 'debug')).toBe('debug');
    expect(inferMode('now the header too', 'copy')).toBe('copy');
    expect(inferMode('now the header too')).toBeUndefined();
  });

  it('a fresh keyword overrides the previous mode — stickiness is only a fallback', () => {
    expect(inferMode('now copy the footer from stripe', 'debug')).toBe('copy');
    expect(inferMode('actually, debug the broken carousel', 'copy')).toBe('debug');
  });
});

describe('resolveMode', () => {
  it('an explicit mode always wins over inference', () => {
    expect(resolveMode('copy', 'debug this broken button')).toBe('copy');
    expect(resolveMode('debug', 'copy the reference site')).toBe('debug');
  });

  it('an explicit mode also wins over the previous session mode', () => {
    expect(resolveMode('copy', 'continue', 'debug')).toBe('copy');
  });

  it('falls back to inference when no explicit mode is given', () => {
    expect(resolveMode(undefined, 'debug my checkout flow')).toBe('debug');
    expect(resolveMode(undefined, 'copy nvidia')).toBe('copy');
  });

  it('falls back to the previous mode when neither explicit nor inferred', () => {
    expect(resolveMode(undefined, 'and the sidebar as well', 'copy')).toBe('copy');
  });

  it('resolves to undefined when nothing carries a mode', () => {
    expect(resolveMode(undefined, 'make the CTA button orange')).toBeUndefined();
  });
});

describe('modeGuidance', () => {
  it('copy mode returns a message-tail addendum and browse-first tool emphasis', () => {
    const guidance = modeGuidance('copy');
    expect(guidance.turnAddendum).toMatch(/copy\/design task/i);
    expect(guidance.turnAddendum).toContain('browse');
    expect(guidance.turnAddendum).toContain('extractIdentity');
    expect(guidance.turnAddendum).toMatch(/apply that identity's palette and type/i);
    expect(guidance.turnAddendum).toMatch(/prefer `describe` over a `screenshot`/i);
    expect(guidance.turnAddendum).toMatch(/check mobile and tablet,\s*not just desktop/i);
    expect(guidance.turnAddendum).toContain('setDevice');
    expect(guidance.turnAddendum).toMatch(/breakpoint/i);
    expect(guidance.toolEmphasis).toEqual([
      'browse',
      'extractIdentity',
      'describe',
      'query',
      'getStyles',
      'a11ySnapshot',
      'setStyle',
      'setText',
      'setDevice',
    ]);
  });

  it('debug mode returns a message-tail addendum and diagnostics-first tool emphasis', () => {
    const guidance = modeGuidance('debug');
    expect(guidance.turnAddendum).toMatch(/debug task/i);
    expect(guidance.turnAddendum).toMatch(/observe.*hypothesize.*reproduce/is);
    expect(guidance.turnAddendum).toMatch(/responsive breakage explicitly/i);
    expect(guidance.turnAddendum).toContain('checkResponsive');
    expect(guidance.toolEmphasis[0]).toBe('diagnostics');
    expect(guidance.toolEmphasis).toContain('setDevice');
    expect(guidance.toolEmphasis).toContain('checkResponsive');
  });

  it('undefined mode returns no addendum and no tool emphasis (the base MODES section already covers it)', () => {
    const guidance = modeGuidance(undefined);
    expect(guidance.addenda).toEqual({});
    expect(guidance.turnAddendum).toBeUndefined();
    expect(guidance.toolEmphasis).toEqual([]);
  });

  it('never populates system-prompt addenda — mode guidance rides the message tail so the system prompt stays byte-stable for prompt caching (#168)', () => {
    for (const mode of ['copy', 'debug', undefined] as const) {
      expect(modeGuidance(mode).addenda).toEqual({});
    }
  });
});
