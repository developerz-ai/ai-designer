import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ElementLike,
  isXPath,
  pickUnique,
  resolveSelector,
  resolveShadowSelector,
  resolveXPath,
  SHADOW_COMBINATOR,
  xpathFor,
} from '@/dom/selector';

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
    // Framework prefixes, React useId, and real content hashes (a segment mixing hex digits +
    // letters).
    for (const id of ['css-1a2b3c', 'sc-bdVaJa', ':r7:', 'a1b2c3', 'x-d41d8cd98f00b204e9800998']) {
      const candidates = resolveSelector(el({ id, tagName: 'SPAN' }));
      expect([id, candidates.every((c) => c.strategy !== 'id')]).toEqual([id, true]);
    }
  });

  // #165 F5: the hash heuristic was UNANCHORED `[0-9a-f]{6,}`, so any six consecutive hex chars
  // anywhere in an id suppressed the stable `#id` candidate — `feedback` is f-e-e-d-b-a-c, and a
  // ≥6-digit number does it too. The fallback css-path then names a different element as soon as
  // the SPA renders one more sibling above the target.
  it('keeps ordinary hand-written ids that merely LOOK hex', () => {
    const ids = [
      'feedback',
      'facade',
      'decade',
      'deface',
      'defaced',
      'effaced',
      'accede',
      'product-123456',
      'order_654321',
    ];
    for (const id of ids) {
      const [top] = resolveSelector(el({ id, tagName: 'SECTION' }));
      expect([id, top?.strategy]).toEqual([id, 'id']);
    }
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

  it('escapes both backslash and quote in a data-attr value, staying querySelector-valid', () => {
    // A value containing a backslash used to emit `[data-testid="a\b"]` — broken, since a lone `\b`
    // is a CSS escape. The backslash must be escaped BEFORE the quote.
    const [top] = resolveSelector(el({ tagName: 'DIV', attrs: { 'data-testid': 'a\\b"c' } }));
    expect(top?.strategy).toBe('data-attr');
    expect(top?.value).toBe('[data-testid="a\\\\b\\"c"]');
    expect(() => document.querySelector(top?.value ?? '')).not.toThrow();
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

describe('pickUnique', () => {
  function mount(html: string): void {
    document.body.innerHTML = html;
  }
  function q(selector: string): Element {
    const found = document.querySelector(selector);
    if (!found) throw new Error(`fixture missing: ${selector}`);
    return found;
  }

  it('gives an anonymous element a scoped css-path that uniquely resolves to it', () => {
    // No data-attr, no stable id, no aria pair, no text — the hard case.
    mount('<section id="anon"><p>lead</p><span></span><span></span></section>');
    const target = q('#anon span:nth-of-type(2)');

    const picked = pickUnique(target, document);
    const hits = document.querySelectorAll(picked.value);
    expect(hits.length).toBe(1);
    expect(hits[0]).toBe(target);
    expect(picked.strategy).toBe('css-path');
  });

  it('returns a selector that resolves to the picked sibling, never the other', () => {
    mount('<ul id="list"><li></li><li></li></ul>');
    const [first, second] = Array.from(document.querySelectorAll('#list li'));
    if (!first || !second) throw new Error('fixture missing siblings');

    const pickedFirst = pickUnique(first, document);
    const pickedSecond = pickUnique(second, document);

    expect(document.querySelector(pickedFirst.value)).toBe(first);
    expect(document.querySelector(pickedSecond.value)).toBe(second);
    expect(pickedFirst.value).not.toBe(pickedSecond.value);
  });

  // #165 F6: the ranked loop rejected the css-path for failing `resolvesToExactly`, then the
  // fallback returned THE SAME value anyway (gated only on "does it parse"). `cssPath` anchored at
  // the nearest ancestor id without checking that id is document-unique, so on a legacy theme that
  // renders `<div id="content">` twice, `queryOne`'s hits[0] landed in the FIRST one — the user
  // watched the wrong heading change.
  it('never anchors a css-path at a DUPLICATED ancestor id', () => {
    mount(
      '<div id="content"><article><h2>First</h2></article></div>' +
        '<div id="content"><article><h2>Second</h2></article></div>',
    );
    const [, second] = Array.from(document.querySelectorAll('h2'));
    if (!second) throw new Error('fixture missing');

    const picked = pickUnique(second, document);

    expect(picked.value).not.toContain('#content');
    const hits = document.querySelectorAll(picked.value);
    expect(hits.length).toBe(1);
    expect(hits[0]).toBe(second);
  });

  it('never returns a css-path it already proved ambiguous', () => {
    mount('<div id="dup"><p><span></span></p></div><div id="dup"><p><span></span></p></div>');
    const [, second] = Array.from(document.querySelectorAll('span'));
    if (!second) throw new Error('fixture missing');

    const picked = pickUnique(second, document);

    expect(document.querySelectorAll(picked.value)).toHaveLength(1);
    expect(document.querySelector(picked.value)).toBe(second);
  });

  it('resolves a text-bearing anonymous element to itself via the css-path fallback', () => {
    // The common real case: same-tag siblings that differ only by text. The bare-tag
    // `text` candidate is not unique, so pickUnique falls through to a scoped css-path.
    mount('<nav id="menu"><a>Home</a><a>About</a><a>Contact</a></nav>');
    const [, about] = Array.from(document.querySelectorAll('#menu a'));
    if (!about) throw new Error('fixture missing');

    const picked = pickUnique(about, document);

    expect(document.querySelectorAll(picked.value).length).toBe(1);
    expect(document.querySelector(picked.value)).toBe(about);
    expect(picked.strategy).toBe('css-path');
  });

  it('rejects a count-of-one match on the wrong element (identity, not count)', () => {
    // The element handed in is NOT the one its own #id selector finds in the doc.
    // `querySelectorAll('#stable').length === 1` is true, so a count-only check
    // would wrongly accept `#stable`; the identity guard (hits[0] === el) must not.
    mount('<main><p id="stable">in document</p></main>');
    const imposter = document.createElement('p');
    imposter.id = 'stable';

    const picked = pickUnique(imposter, document);

    expect(document.querySelectorAll('#stable').length).toBe(1);
    expect(picked.value).not.toBe('#stable');
    expect(picked.strategy).toBe('css-path');
    expect(picked.fragile).toBe(true);
  });

  it('degrades to a fragile css-path rather than throwing when nothing resolves uniquely', () => {
    mount('<div></div><div></div>');
    const orphan = document.createElement('div');

    const picked = pickUnique(orphan, document);

    expect(picked.strategy).toBe('css-path');
    expect(picked.fragile).toBe(true);
    expect(() => document.querySelector(picked.value)).not.toThrow();
  });

  it('only ever considers querySelector-valid candidate values', () => {
    mount('<a data-testid="x" role="link" aria-label="Home" id="home">Home</a>');
    const anchor = q('a');

    for (const c of resolveSelector(anchor)) {
      expect(() => document.querySelector(c.value)).not.toThrow();
    }
    expect(() => document.querySelector(pickUnique(anchor, document).value)).not.toThrow();
  });

  // A leading digit is legal in an HTML id and illegal at the head of a CSS ident.
  // Anchoring the css-path at such an ancestor must hex-escape it, or every consumer
  // that calls querySelector on the result throws.
  it('escapes a digit-leading ancestor id so the anchored css-path still parses', () => {
    mount('<div id="2col"><span></span><span></span></div>');
    const target = document.querySelectorAll('span')[1] as Element;

    const picked = pickUnique(target, document);

    expect(() => document.querySelector(picked.value)).not.toThrow();
    expect(document.querySelector(picked.value)).toBe(target);
  });

  // Unescaped, `#2col` throws and the id candidate is silently rejected, so the element
  // degrades to a css-path. Escaped, the far more stable `id` strategy is kept.
  it('keeps the id strategy for a digit-leading id on the element itself', () => {
    mount('<div id="2col"></div>');
    const target = q('#\\32 col');

    const picked = pickUnique(target, document);

    expect(picked.strategy).toBe('id');
    expect(() => document.querySelector(picked.value)).not.toThrow();
    expect(document.querySelector(picked.value)).toBe(target);
  });

  it('escapes an id that is a lone hyphen', () => {
    mount('<div id="-"><em></em><em></em></div>');
    const target = document.querySelectorAll('em')[1] as Element;

    const picked = pickUnique(target, document);

    expect(() => document.querySelector(picked.value)).not.toThrow();
    expect(document.querySelector(picked.value)).toBe(target);
  });
});

describe('shadow-aware selectors', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function q(selector: string): Element {
    const found = document.querySelector(selector);
    if (!found) throw new Error(`fixture missing: ${selector}`);
    return found;
  }
  function inShadow(root: ShadowRoot, selector: string): Element {
    const found = root.querySelector(selector);
    if (!found) throw new Error(`shadow fixture missing: ${selector}`);
    return found;
  }

  it('emits a host-path `shadow` selector for an element in an OPEN shadow root', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const root = q('#host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button data-testid="ok">OK</button>';
    const btn = inShadow(root, 'button');

    const picked = pickUnique(btn, document);

    expect(picked.strategy).toBe('shadow');
    expect(picked.value).toBe(`#host${SHADOW_COMBINATOR}[data-testid="ok"]`);
    expect(picked.fragile).toBe(false);
    expect(resolveShadowSelector(document, picked.value)).toBe(btn);
  });

  it('crosses nested OPEN roots with one `>>>` per boundary and replays to the target', () => {
    document.body.innerHTML = '<div id="outer"></div>';
    const outerRoot = q('#outer').attachShadow({ mode: 'open' });
    outerRoot.innerHTML = '<section id="mid"></section>';
    const midRoot = inShadow(outerRoot, '#mid').attachShadow({ mode: 'open' });
    midRoot.innerHTML = '<a data-testid="deep">deep</a>';
    const deep = inShadow(midRoot, 'a');

    const picked = pickUnique(deep, document);

    expect(picked.strategy).toBe('shadow');
    expect(picked.value.split(SHADOW_COMBINATOR)).toEqual([
      '#outer',
      '#mid',
      '[data-testid="deep"]',
    ]);
    expect(resolveShadowSelector(document, picked.value)).toBe(deep);
  });

  it('resolves an anonymous shadow element via a scoped css-path, to the right sibling', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const root = q('#host').attachShadow({ mode: 'open' });
    root.innerHTML = '<ul><li></li><li></li></ul>';
    const [first, second] = Array.from(root.querySelectorAll('li'));
    if (!first || !second) throw new Error('fixture missing siblings');

    const picked = pickUnique(second, document);

    expect(picked.strategy).toBe('shadow');
    expect(picked.value.startsWith(`#host${SHADOW_COMBINATOR}`)).toBe(true);
    expect(resolveShadowSelector(document, picked.value)).toBe(second);
    expect(resolveShadowSelector(document, picked.value)).not.toBe(first);
  });

  it('flags a CLOSED shadow root fragile and falls back to the host (coordinate/vision anchor)', () => {
    document.body.innerHTML = '<div id="widget"></div>';
    const root = q('#widget').attachShadow({ mode: 'closed' });
    root.innerHTML = '<input data-testid="field" />';
    const field = inShadow(root, 'input');

    const picked = pickUnique(field, document);

    expect(picked.strategy).toBe('shadow');
    expect(picked.fragile).toBe(true);
    // A closed root can't be pierced from outside — the deepest resolvable target is the host.
    expect(picked.value).toBe('#widget');
    expect(resolveShadowSelector(document, picked.value)).toBe(q('#widget'));
  });

  it('ranks resolveSelector shadow candidates most-stable-first, each host-path prefixed', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const root = q('#host').attachShadow({ mode: 'open' });
    root.innerHTML =
      '<button data-testid="cta" id="buy" role="button" aria-label="Buy">Buy</button>';
    const btn = inShadow(root, 'button');

    const candidates = resolveSelector(btn);

    expect(candidates.every((c) => c.strategy === 'shadow')).toBe(true);
    expect(candidates.every((c) => c.value.startsWith(`#host${SHADOW_COMBINATOR}`))).toBe(true);
    expect(candidates[0]?.value).toBe(`#host${SHADOW_COMBINATOR}[data-testid="cta"]`);
  });

  it('leaves a light-DOM element on plain-CSS strategies (never a shadow path)', () => {
    document.body.innerHTML = '<main><button id="go">Go</button></main>';
    const btn = q('#go');

    const picked = pickUnique(btn, document);

    expect(picked.strategy).not.toBe('shadow');
    expect(picked.value).not.toContain('>>>');
    for (const c of resolveSelector(btn)) {
      expect(c.strategy).not.toBe('shadow');
    }
  });

  it('resolveShadowSelector returns null when a path cannot be pierced or is malformed', () => {
    document.body.innerHTML = '<div id="host"></div>';
    q('#host').attachShadow({ mode: 'closed' });

    expect(resolveShadowSelector(document, `#host${SHADOW_COMBINATOR}button`)).toBe(null);
    expect(resolveShadowSelector(document, `#nope${SHADOW_COMBINATOR}button`)).toBe(null);
    expect(resolveShadowSelector(document, `#host${SHADOW_COMBINATOR}`)).toBe(null);
  });
});

describe('xpath strategy', () => {
  // Added because `pickUnique`'s last-resort used to be a BARE TAG (`div`) — and `queryOne` takes
  // hits[0], so a fallback like that silently pointed the next mutation at the first div on the
  // page. An XPath is unique by construction, so the worst case now still names the right element.
  it('builds an absolute, index-qualified path to the document element', () => {
    document.body.innerHTML = '<section><p>one</p><p id="target">two</p></section>';
    const el = document.getElementById('target');
    if (!el) throw new Error('fixture missing');
    expect(xpathFor(el)).toBe('/html/body[1]/section[1]/p[2]');
  });

  it('indexes only among SAME-TAG siblings, like nth-of-type', () => {
    document.body.innerHTML = '<div><span>a</span><b>b</b><span id="s2">c</span></div>';
    const el = document.getElementById('s2');
    if (!el) throw new Error('fixture missing');
    // Second <span>, not the third child.
    expect(xpathFor(el)).toBe('/html/body[1]/div[1]/span[2]');
  });

  it('round-trips: every path it builds resolves back to exactly that element', () => {
    document.body.innerHTML =
      '<main><ul><li>a</li><li><a href="#">link</a></li></ul><ul><li>b</li></ul></main>';
    for (const el of Array.from(document.querySelectorAll('*'))) {
      expect(resolveXPath(document, xpathFor(el))).toBe(el);
    }
  });

  it('isXPath discriminates on the leading slash a CSS selector can never have', () => {
    expect(isXPath('/html/body[1]/div[1]')).toBe(true);
    expect(isXPath('#cta')).toBe(false);
    expect(isXPath('div > span')).toBe(false);
    expect(isXPath('.a >>> .b')).toBe(false);
  });

  it('resolveXPath returns null for a miss or a malformed expression rather than throwing', () => {
    document.body.innerHTML = '<div></div>';
    expect(resolveXPath(document, '/html/body[1]/section[9]')).toBeNull();
    expect(resolveXPath(document, '/html/body[1]/div[')).toBeNull();
  });

  it('is NOT a selector candidate — those must all stay querySelector-valid', () => {
    // The constraint that makes this a separate field rather than a seventh candidate: consumers
    // pass candidate values straight to `querySelector`, and an XPath throws there. It reaches the
    // agent on `element-picked.xpath` instead.
    document.body.innerHTML = '<button id="cta" data-testid="buy">Buy</button>';
    const el = document.getElementById('cta');
    if (!el) throw new Error('fixture missing');
    expect(resolveSelector(el).map((c) => c.strategy)).not.toContain('xpath');
    expect(pickUnique(el, document).strategy).not.toBe('xpath');
  });
});
