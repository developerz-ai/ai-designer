import { beforeEach, describe, expect, it } from 'vitest';
import { createMutator, cssDenyReason, SHEET_ATTR } from '@/dom/mutate';

// The two mutation primitives a full-page overhaul needs and did not have: taking an attribute
// AWAY, and writing a page-wide stylesheet that can be rewritten in place.

describe('removeAttr', () => {
  beforeEach(() => {
    document.body.innerHTML = '<table id="t" width="85%" align="center"><tbody></tbody></table>';
  });

  it('fills the AttrChange.after === null branch no producer could emit before', () => {
    // `AttrChange.after` is declared nullable in src/shared/changeset.ts and documented as "the
    // attribute was removed" — and until now nothing could produce it. Half the legacy-markup
    // design moves (drop a presentational width/align/bgcolor) were simply unreachable.
    const el = document.getElementById('t');
    if (!el) throw new Error('fixture');
    const m = createMutator(document).removeAttr(el, 'width');

    expect(el.hasAttribute('width')).toBe(false);
    expect(m.attrChange).toEqual({ name: 'width', before: '85%', after: null });
    expect(m.kind).toBe('setAttr'); // the durable Edit already models this exactly
  });

  it('restores the exact prior value on undo', () => {
    const el = document.getElementById('t');
    if (!el) throw new Error('fixture');
    const m = createMutator(document).removeAttr(el, 'align');
    m.undo();
    expect(el.getAttribute('align')).toBe('center');
  });

  it('records nothing for an attribute that was already absent', () => {
    const el = document.getElementById('t');
    if (!el) throw new Error('fixture');
    // A no-op must not emit a delta the changeset fold would have to cancel back out — the same
    // real-delta rule addClass/removeClass follow.
    expect(createMutator(document).removeAttr(el, 'bgcolor').attrChange).toBeUndefined();
  });

  it('refuses to strip the editor own overrides marker', () => {
    const el = document.getElementById('t');
    if (!el) throw new Error('fixture');
    expect(() => createMutator(document).removeAttr(el, 'data-dz-designer')).toThrow(/reserved/i);
  });
});

describe('injectCss', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '<main></main>';
  });

  const sheets = (): HTMLStyleElement[] =>
    Array.from(document.querySelectorAll(`style[${SHEET_ATTR}]`));

  it('replaces a named sheet instead of stacking another one on top', () => {
    // An overhaul is iterative. Ten accumulated stylesheets with escalating specificity make
    // "what is the current design?" unanswerable, and undo meaningless.
    const mutator = createMutator(document);
    mutator.injectCss('main { color: red }', 'overhaul');
    mutator.injectCss('main { color: blue }', 'overhaul');

    expect(sheets()).toHaveLength(1);
    expect(sheets()[0]?.textContent).toBe('main { color: blue }');
  });

  it('keeps separately named sheets apart', () => {
    const mutator = createMutator(document);
    mutator.injectCss('main { color: red }', 'tokens');
    mutator.injectCss('main { color: blue }', 'layout');
    expect(sheets()).toHaveLength(2);
  });

  it('undo restores the previous text, and removes the sheet when there was none', () => {
    const mutator = createMutator(document);
    const first = mutator.injectCss('main { color: red }', 'overhaul');
    const second = mutator.injectCss('main { color: blue }', 'overhaul');

    second.undo();
    expect(sheets()[0]?.textContent).toBe('main { color: red }');
    first.undo();
    expect(sheets()).toHaveLength(0);
  });
});

describe('cssDenyReason', () => {
  it('refuses @import — it loads a remote stylesheet into the page world', () => {
    expect(cssDenyReason('@import url("https://fonts.example/x.css");')).toMatch(/@import/);
  });

  it('refuses a remote url(), the CSS exfiltration channel', () => {
    for (const css of [
      'a { background: url(https://evil.example/leak) }',
      'a { background: url("//evil.example/leak") }',
      "a { background: url('HTTPS://evil.example/leak') }",
    ]) {
      expect([css, cssDenyReason(css)]).not.toEqual([css, null]);
    }
  });

  it('sees through control characters the URL parser ignores', () => {
    expect(cssDenyReason('a { background: url("ht\ttps://evil.example/x") }')).not.toBeNull();
  });

  it('allows the two url() forms that issue no request', () => {
    expect(cssDenyReason('a { clip-path: url(#mask) }')).toBeNull();
    expect(cssDenyReason('a { background: url(data:image/svg+xml;base64,AAA) }')).toBeNull();
  });

  it('refuses the legacy stylesheet script channels', () => {
    expect(cssDenyReason('a { behavior: url(x.htc) }')).not.toBeNull();
    expect(cssDenyReason('a { width: expression(alert(1)) }')).not.toBeNull();
  });

  it('passes ordinary overhaul CSS, custom properties and media queries included', () => {
    const css = [
      ':root { --space-4: 1rem; --accent: #6366f1 }',
      'main { max-width: 72rem; margin-inline: auto }',
      '@media (max-width: 640px) { main { padding: var(--space-4) } }',
    ].join('\n');
    expect(cssDenyReason(css)).toBeNull();
  });

  it('is enforced at the primitive, not only at the caller', () => {
    expect(() => createMutator(document).injectCss('@import "x.css";')).toThrow(/@import/);
  });
});
