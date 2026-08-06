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
  const names: IconName[] = [
    'settings',
    'mcp',
    'ship',
    'check',
    'close',
    'warning',
    'spinner',
    'target',
    'trash',
    'add',
    'chevronDown',
    'externalLink',
    'copy',
    'eye',
    'agent',
    'status',
  ];

  it.each(names)('renders the registered glyph for "%s"', (name) => {
    expect(buildIconSvg(name).getAttribute('data-icon')).toBe(name);
  });
});

// The glyphs are one stroke language (16 viewBox, 1.5 stroke, currentColor). A CSS `fill`
// on the <svg> would outrank this and flood every outline solid, so the root attributes
// are part of the contract, not decoration — see the comment in Icon.scss.
describe('Icon — stroke language', () => {
  it('sets the shared stroke attributes on the root, not on each node', () => {
    const svg = buildIconSvg('check' satisfies IconName);
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-width')).toBe('1.5');
  });

  it('lets a deliberately-filled glyph override the root on its own node', () => {
    const dot = buildIconSvg('status' satisfies IconName).querySelectorAll('circle')[1];
    expect(dot?.getAttribute('fill')).toBe('currentColor');
    expect(dot?.getAttribute('stroke')).toBe('none');
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
