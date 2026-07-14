import { describe, expect, it } from 'vitest';
import { extractDesignRead, parseColor, primaryFamily } from '@/dom/design-read';

// design-read.ts unit: reduce a live DOM to a compact, token-bounded design identity. Pure DOM in
// (jsdom), typed DesignRead out — no chrome.*. Fixtures use inline styles so getComputedStyle
// resolves deterministically under jsdom (same path the browse tool drives in a real page).

function mount(html: string): void {
  document.head.innerHTML = '';
  document.body.setAttribute('style', 'font-size:16px');
  document.body.innerHTML = html;
}

const PAGE = `
  <header aria-label="Site header">
    <h1 style="color:#111827;font-family:Inter,sans-serif;font-size:32px">Acme</h1>
  </header>
  <nav aria-label="Primary">
    <a href="/home" style="color:#2563eb;font-size:16px">Home</a>
    <a href="/pricing" style="color:#2563eb;font-size:16px">Pricing</a>
  </nav>
  <main>
    <button style="background-color:#f97316;color:#ffffff;font-size:14px">Buy now</button>
    <p style="color:#374151;font-family:Inter,sans-serif;font-size:16px">Body copy here.</p>
    <input type="text" aria-label="Email" />
    <input type="hidden" />
    <img alt="Hero" />
    <article class="card" style="background-color:#ffffff;border:1px solid #e5e7eb">
      <h2 style="color:#111827;font-size:20px">Card title</h2>
    </article>
  </main>
  <footer aria-label="Footer"></footer>`;

describe('extractDesignRead', () => {
  it('reads the page title and location', () => {
    mount(PAGE); // wipes <head>, so set the title after
    document.title = 'Acme — Home';
    const read = extractDesignRead(document, window);
    expect(read.title).toBe('Acme — Home');
    expect(typeof read.url).toBe('string');
  });

  it('builds a palette of normalized hexes with a dominant role', () => {
    mount(PAGE);
    const { palette } = extractDesignRead(document, window);

    // The accent used as a button background surfaces with the background role.
    expect(palette).toContainEqual({ hex: '#f97316', role: 'background', count: 1 });
    // Link ink is a text color; both links share it, so its count is 2.
    expect(palette).toContainEqual({ hex: '#2563eb', role: 'text', count: 2 });
    // Every entry is a lowercase #rrggbb.
    for (const c of palette) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(palette.length).toBeLessThanOrEqual(12);
  });

  it('captures the type scale and families ordered by usage', () => {
    mount(PAGE);
    const { typography } = extractDesignRead(document, window);
    expect(typography.families[0]).toBe('Inter');
    // Distinct sizes, largest first.
    expect(typography.scale).toEqual([32, 20, 16, 14]);
    expect(typography.baseSize).toBe(16);
  });

  it('lists the layout landmarks with their accessible names', () => {
    mount(PAGE);
    const { regions } = extractDesignRead(document, window);
    expect(regions).toContainEqual({ role: 'banner', name: 'Site header' });
    expect(regions).toContainEqual({ role: 'navigation', name: 'Primary' });
    expect(regions).toContainEqual({ role: 'contentinfo', name: 'Footer' });
    expect(regions.some((r) => r.role === 'main')).toBe(true);
  });

  it('counts the key component vocabulary (excludes hidden inputs)', () => {
    mount(PAGE);
    const { components } = extractDesignRead(document, window);
    const count = (kind: string) => components.find((c) => c.kind === kind)?.count ?? 0;
    expect(count('button')).toBe(1);
    expect(count('link')).toBe(2);
    expect(count('input')).toBe(1); // the text input; the hidden one is excluded
    expect(count('heading')).toBe(2);
    expect(count('image')).toBe(1);
    expect(count('card')).toBe(1);
    // Only present kinds are reported.
    expect(components.every((c) => c.count > 0)).toBe(true);
  });

  it('bounds the palette by maxColors', () => {
    mount(PAGE);
    expect(extractDesignRead(document, window, { maxColors: 2 }).palette.length).toBe(2);
  });

  it('never throws on an empty document', () => {
    mount('');
    const read = extractDesignRead(document, window);
    expect(read.regions).toEqual([]);
    expect(read.components).toEqual([]);
  });
});

describe('parseColor', () => {
  it('normalizes rgb()/rgba() to lowercase #rrggbb', () => {
    expect(parseColor('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(parseColor('rgba(16, 24, 40, 0.5)')).toBe('#101828');
  });

  it('returns null for fully-transparent / none / empty / named colors', () => {
    expect(parseColor('rgba(0, 0, 0, 0)')).toBeNull();
    expect(parseColor('transparent')).toBeNull();
    expect(parseColor('none')).toBeNull();
    expect(parseColor('')).toBeNull();
    expect(parseColor(undefined)).toBeNull();
    expect(parseColor('inherit')).toBeNull();
  });

  it('expands and normalizes hex forms, honoring a zero alpha', () => {
    expect(parseColor('#ABC')).toBe('#aabbcc');
    expect(parseColor('#123456')).toBe('#123456');
    expect(parseColor('#12345678')).toBe('#123456');
    expect(parseColor('#00000000')).toBeNull();
    expect(parseColor('#0000')).toBeNull(); // #rgba with a=0
  });
});

describe('primaryFamily', () => {
  it('takes the first family in a stack, unquoted', () => {
    expect(primaryFamily('"Inter", sans-serif')).toBe('Inter');
    expect(primaryFamily('Inter, sans-serif')).toBe('Inter');
    expect(primaryFamily("'Helvetica Neue', Arial")).toBe('Helvetica Neue');
  });

  it('returns empty for missing input', () => {
    expect(primaryFamily('')).toBe('');
    expect(primaryFamily(undefined)).toBe('');
  });
});
