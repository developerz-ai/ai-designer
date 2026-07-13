import { describe, expect, it } from 'vitest';
import {
  buildIconClass,
  buildIconSvg,
  type IconName,
} from '@/entrypoints/sidepanel/components/icon-registry';

// Icon rendering contract exercised through its pure building blocks — `buildIconSvg`
// (SVG DOM) and `buildIconClass` (host <span> class list). Both are side-effect-free
// (CLAUDE.md "no business logic in components"), so `Icon.tsx` itself stays an
// untested-in-isolation thin wrapper; these are the tests that matter for its behavior.

describe('Icon — name resolves to expected SVG', () => {
  const cases: Array<[IconName, string]> = [
    ['send', 'paper-plane'],
    ['settings', 'gear'],
    ['mcp', 'plug'],
    ['ship', 'rocket'],
    ['check', 'check'],
    ['close', 'xmark'],
    ['warning', 'triangle-exclamation'],
    ['spinner', 'spinner'],
    ['picker', 'arrow-pointer'],
    ['trash', 'trash'],
    ['add', 'plus'],
    ['chevronDown', 'chevron-down'],
    ['externalLink', 'arrow-up-right-from-square'],
    ['copy', 'copy'],
    ['eye', 'eye'],
    ['agent', 'wand-magic-sparkles'],
    ['status', 'circle-dot'],
  ];

  it.each(cases)('renders the registered glyph for "%s"', (name, expectedGlyph) => {
    const svg = buildIconSvg(name);
    expect(svg.getAttribute('data-icon')).toBe(expectedGlyph);
  });
});

describe('Icon — unknown name falls back instead of throwing', () => {
  it('renders the fallback glyph for an unregistered name', () => {
    const fallback = buildIconSvg('totally-unknown-icon');
    const warning = buildIconSvg('warning' satisfies IconName);
    expect(fallback.getAttribute('data-icon')).toBe(warning.getAttribute('data-icon'));
  });

  it('never throws for an arbitrary runtime string', () => {
    expect(() => buildIconSvg('')).not.toThrow();
    expect(() => buildIconSvg('<script>alert(1)</script>')).not.toThrow();
  });
});

describe('Icon — size classes', () => {
  it('defaults to md when no size is given', () => {
    expect(buildIconClass()).toBe('dz-icon dz-icon--md');
  });

  it.each([
    ['sm', 'dz-icon dz-icon--sm'],
    ['md', 'dz-icon dz-icon--md'],
    ['lg', 'dz-icon dz-icon--lg'],
  ] as const)('maps size "%s" to "%s"', (size, expected) => {
    expect(buildIconClass({ size })).toBe(expected);
  });
});

describe('Icon — spin class', () => {
  it('omits dz-icon--spin when spin is false/unset', () => {
    expect(buildIconClass({ size: 'md' })).not.toContain('dz-icon--spin');
  });

  it('appends dz-icon--spin when spin is true', () => {
    expect(buildIconClass({ size: 'md', spin: true })).toBe('dz-icon dz-icon--md dz-icon--spin');
  });

  it('combines a caller class with size and spin', () => {
    expect(buildIconClass({ size: 'lg', spin: true, class: 'send-button__icon' })).toBe(
      'dz-icon dz-icon--lg dz-icon--spin send-button__icon',
    );
  });
});
