import { describe, expect, it } from 'vitest';
import { type ElementLike, resolveSelector } from '@/dom/selector';

function el(over: Partial<ElementLike> & { attrs?: Record<string, string> }): ElementLike {
  const attrs = over.attrs ?? {};
  return {
    id: over.id ?? '',
    tagName: over.tagName ?? 'DIV',
    textContent: over.textContent ?? '',
    getAttribute: (name) => attrs[name] ?? null,
  };
}

describe('resolveSelector', () => {
  it('ranks data-testid first', () => {
    const [top] = resolveSelector(el({ attrs: { 'data-testid': 'cta-primary' }, id: 'x' }));
    expect(top?.strategy).toBe('data-attr');
    expect(top?.value).toBe('[data-testid="cta-primary"]');
    expect(top?.fragile).toBe(false);
  });

  it('falls back to a stable id', () => {
    const [top] = resolveSelector(el({ id: 'main-nav' }));
    expect(top?.strategy).toBe('id');
    expect(top?.value).toBe('#main-nav');
  });

  it('skips generated ids', () => {
    const candidates = resolveSelector(el({ id: 'css-1a2b3c', tagName: 'SPAN' }));
    expect(candidates.every((c) => c.strategy !== 'id')).toBe(true);
  });

  it('uses aria role + label', () => {
    const [top] = resolveSelector(
      el({ tagName: 'BUTTON', attrs: { role: 'button', 'aria-label': 'Close' } }),
    );
    expect(top?.strategy).toBe('aria');
    expect(top?.value).toBe('button[role="button"][aria-label="Close"]');
  });

  it('flags the css-path fallback as fragile', () => {
    const candidates = resolveSelector(el({ tagName: 'DIV', textContent: '' }));
    const last = candidates.at(-1);
    expect(last?.strategy).toBe('css-path');
    expect(last?.fragile).toBe(true);
  });

  it('returns candidates in priority order, most stable first', () => {
    const candidates = resolveSelector(
      el({
        tagName: 'BUTTON',
        id: 'buy',
        attrs: { 'data-testid': 'cta', role: 'button', 'aria-label': 'Buy' },
        textContent: 'Buy now',
      }),
    );
    expect(candidates.map((c) => c.strategy)).toEqual(['data-attr', 'id', 'aria', 'text']);
    // Strong candidates are not fragile; the structural fallback is.
    expect(candidates[0]?.fragile).toBe(false);
    expect(candidates.at(-1)?.fragile).toBe(true);
  });

  it('never emits an invalid :has-text() pseudo — the text candidate is querySelector-valid', () => {
    // A text-bearing element used to yield `button:has-text("...")`, which throws
    // in document.querySelector. The text candidate is now a valid structural selector.
    const candidates = resolveSelector(el({ tagName: 'BUTTON', textContent: 'Click me' }));
    expect(candidates.some((c) => c.strategy === 'text')).toBe(true);
    for (const c of candidates) {
      expect(c.value).not.toContain(':has-text');
      expect(() => document.querySelector(c.value)).not.toThrow();
    }
  });

  it('emits only querySelector-valid candidate values across every strategy', () => {
    const candidates = resolveSelector(
      el({
        tagName: 'A',
        id: 'home',
        attrs: { 'data-testid': 'nav-home', role: 'link', 'aria-label': 'Home' },
        textContent: 'Home',
      }),
    );
    for (const c of candidates) {
      expect(() => document.querySelector(c.value)).not.toThrow();
    }
  });
});
