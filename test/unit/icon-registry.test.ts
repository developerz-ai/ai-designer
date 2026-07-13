import { describe, expect, it } from 'vitest';
import {
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
});
