import { describe, expect, it } from 'vitest';
import {
  buildIconClass,
  buildIconSvg,
  ICON_NAMES,
  type IconName,
  resolveIconName,
} from '@/entrypoints/sidepanel/components/icon-registry';

// buildIconSvg builds real SVG DOM from FontAwesome's abstract node data — no
// `innerHTML`/HTML-string parsing anywhere in the path (CLAUDE.md "Icon component
// (inline SVG, tree-shaken, no innerHTML-of-remote)"). These tests exercise the actual
// DOM shape it produces, not a snapshot of markup.

describe('resolveIconName', () => {
  it('passes through a registered name', () => {
    expect(resolveIconName('send')).toBe('send');
  });

  it('falls back to a safe placeholder for an unregistered name', () => {
    // Cast past the compile-time union: this guards runtime values that cross a
    // serialization boundary (persisted settings, a cross-world message) and were
    // never checked against IconName.
    expect(resolveIconName('not-a-real-icon')).toBe('warning');
  });

  it('every declared name resolves to itself', () => {
    for (const name of ICON_NAMES) {
      expect(resolveIconName(name)).toBe(name);
    }
  });
});

describe('buildIconSvg', () => {
  it('renders a namespaced <svg data-icon> element for a known name', () => {
    const svg = buildIconSvg('send' satisfies IconName);
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('data-icon')).toBe('paper-plane');
  });

  it('builds a nested <path> with real path data, no innerHTML', () => {
    const svg = buildIconSvg('settings' satisfies IconName);
    const path = svg.querySelector('path');
    expect(path).not.toBeNull();
    expect(path?.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(path?.getAttribute('d')?.length).toBeGreaterThan(0);
    // Nothing in the build path ever assigns innerHTML/outerHTML.
    expect(svg.innerHTML.includes('<script')).toBe(false);
  });

  it('falls back to a placeholder glyph for an unknown name instead of throwing', () => {
    expect(() => buildIconSvg('does-not-exist')).not.toThrow();
    const fallback = buildIconSvg('does-not-exist');
    const known = buildIconSvg('warning' satisfies IconName);
    expect(fallback.getAttribute('data-icon')).toBe(known.getAttribute('data-icon'));
  });

  it('produces distinct markup per registered icon', () => {
    const send = buildIconSvg('send' satisfies IconName);
    const trash = buildIconSvg('trash' satisfies IconName);
    expect(send.getAttribute('data-icon')).not.toBe(trash.getAttribute('data-icon'));
  });

  // Generic over ICON_NAMES so registering a glyph is covered without touching this
  // file — a bad import (wrong FontAwesome export, undefined definition) fails here.
  it('builds a distinct, non-empty glyph for every registered name', () => {
    const seen = new Set<string>();
    for (const name of ICON_NAMES) {
      const svg = buildIconSvg(name);
      const dataIcon = svg.getAttribute('data-icon');
      expect(dataIcon, name).toBeTruthy();
      expect(svg.querySelector('path')?.getAttribute('d')?.length ?? 0, name).toBeGreaterThan(0);
      expect(seen.has(dataIcon ?? ''), `duplicate glyph for "${name}"`).toBe(false);
      seen.add(dataIcon ?? '');
    }
    expect(seen.size).toBe(ICON_NAMES.length);
  });
});

describe('buildIconClass', () => {
  it('defaults to the em-relative md size', () => {
    expect(buildIconClass()).toBe('dz-icon dz-icon--md');
  });

  it('adds the fixed modifier so chrome glyphs stop scaling with the parent font-size', () => {
    expect(buildIconClass({ size: 'sm', fixed: true })).toBe('dz-icon dz-icon--sm dz-icon--fixed');
  });

  it('keeps spin and a caller-supplied class alongside the size modifiers', () => {
    expect(buildIconClass({ size: 'lg', fixed: true, spin: true, class: 'dz-header__glyph' })).toBe(
      'dz-icon dz-icon--lg dz-icon--fixed dz-icon--spin dz-header__glyph',
    );
  });
});
