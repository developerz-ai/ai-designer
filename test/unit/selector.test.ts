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
  it('prefers data-testid', () => {
    const s = resolveSelector(el({ attrs: { 'data-testid': 'cta-primary' }, id: 'x' }));
    expect(s.strategy).toBe('data-attr');
    expect(s.value).toBe('[data-testid="cta-primary"]');
    expect(s.fragile).toBe(false);
  });

  it('falls back to a stable id', () => {
    const s = resolveSelector(el({ id: 'main-nav' }));
    expect(s.strategy).toBe('id');
    expect(s.value).toBe('#main-nav');
  });

  it('skips generated ids', () => {
    const s = resolveSelector(el({ id: 'css-1a2b3c', tagName: 'SPAN' }));
    expect(s.strategy).not.toBe('id');
  });

  it('uses aria role + label', () => {
    const s = resolveSelector(
      el({ tagName: 'BUTTON', attrs: { role: 'button', 'aria-label': 'Close' } }),
    );
    expect(s.strategy).toBe('aria');
  });

  it('flags css-path as fragile', () => {
    const s = resolveSelector(el({ tagName: 'DIV', textContent: '' }));
    expect(s.strategy).toBe('css-path');
    expect(s.fragile).toBe(true);
  });
});
