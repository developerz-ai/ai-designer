import { describe, expect, it } from 'vitest';
import { extractIdentity } from '@/dom/identity';

// identity.ts unit: reduce a live DOM to a role-tagged palette + type scale + spacing/radius/shadow
// rhythm. Pure DOM in (jsdom), typed Identity out — no chrome.*. Fixtures use inline styles so
// getComputedStyle resolves deterministically under jsdom (the same path extractIdentity drives in a
// real page).

function mount(html: string): void {
  document.head.innerHTML = '';
  document.body.setAttribute('style', 'font-size:16px');
  document.body.innerHTML = html;
}

const PAGE = `
  <header>
    <h1 style="color:#111827;font-family:Inter,sans-serif;font-size:32px;font-weight:700">Acme</h1>
  </header>
  <nav>
    <a href="/a" style="color:#2563eb;font-size:16px">Home</a>
    <a href="/b" style="color:#2563eb;font-size:16px">Docs</a>
  </nav>
  <main style="padding:16px;background-color:#ffffff">
    <button style="background-color:#f97316;color:#ffffff;font-size:14px;font-weight:600;border-radius:8px;padding:8px;box-shadow:0 1px 2px rgba(0,0,0,0.2)">Buy</button>
    <p style="color:#374151;font-family:Inter,sans-serif;font-size:16px;font-weight:400;margin:8px">Body copy.</p>
    <article style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,0.2)">
      <h2 style="color:#111827;font-size:20px;font-weight:600">Card title</h2>
    </article>
  </main>`;

const isAscending = (xs: number[]): boolean => xs.every((v, i) => i === 0 || v >= (xs[i - 1] ?? v));

describe('extractIdentity — palette', () => {
  it('tags CTA/link colors as accent, ranked with dominant surface/ink', () => {
    mount(PAGE);
    const { palette } = extractIdentity(document, window);

    // Button fill + link ink are call-to-action colors -> accent role.
    expect(palette).toContainEqual({ hex: '#f97316', role: 'accent', count: 1 });
    expect(palette).toContainEqual({ hex: '#2563eb', role: 'accent', count: 2 });
    // Heading/body ink -> fg; drawn border color -> border; shared surface -> bg.
    expect(palette).toContainEqual({ hex: '#111827', role: 'fg', count: 2 });
    expect(palette).toContainEqual({ hex: '#e5e7eb', role: 'border', count: 1 });
    expect(palette).toContainEqual({ hex: '#ffffff', role: 'bg', count: 3 });
  });

  it('normalizes every entry to a lowercase #rrggbb and sorts by count', () => {
    mount(PAGE);
    const { palette } = extractIdentity(document, window);
    for (const c of palette) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
    const counts = palette.map((c) => c.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('bounds the palette by maxColors', () => {
    mount(PAGE);
    expect(extractIdentity(document, window, { maxColors: 2 }).palette.length).toBe(2);
  });
});

describe('extractIdentity — type scale', () => {
  it('collects families by usage, sizes desc, weights asc', () => {
    mount(PAGE);
    const { type } = extractIdentity(document, window);
    expect(type.families).toEqual(['Inter']);
    expect(type.sizes).toEqual([32, 20, 16, 14]);
    expect(type.weights).toEqual([400, 600, 700]);
  });
});

describe('extractIdentity — spacing / radius / shadow', () => {
  it('surfaces the spacing rhythm as an ascending px scale', () => {
    mount(PAGE);
    const { spacing } = extractIdentity(document, window);
    expect(spacing).toContain(8);
    expect(spacing).toContain(16);
    expect(isAscending(spacing)).toBe(true);
    expect(spacing.length).toBeLessThanOrEqual(8);
  });

  it('collects distinct non-zero radii, ascending', () => {
    mount(PAGE);
    expect(extractIdentity(document, window).radius).toEqual([8]);
  });

  it('collects distinct drawn shadows', () => {
    mount(PAGE);
    const { shadows } = extractIdentity(document, window);
    expect(shadows.length).toBe(1);
    expect(shadows[0]).toContain('1px 2px');
  });
});

describe('extractIdentity — bounds', () => {
  it('never throws on an empty document', () => {
    mount('');
    const identity = extractIdentity(document, window);
    expect(identity.palette).toEqual([]);
    expect(identity.type).toEqual({ families: [], sizes: [], weights: [] });
    expect(identity.spacing).toEqual([]);
    expect(identity.radius).toEqual([]);
    expect(identity.shadows).toEqual([]);
  });
});
