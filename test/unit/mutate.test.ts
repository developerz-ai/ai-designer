import { describe, expect, it } from 'vitest';
import { attrDenyReason, createMutator, MARKER_ATTR } from '@/dom/mutate';

const SHEET_ID = 'dz-designer-overrides';

function mount(html: string): void {
  document.documentElement.removeAttribute('style');
  document.head.innerHTML = '';
  document.body.innerHTML = html;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fixture missing: #${id}`);
  return el;
}

function sheetText(): string {
  return document.getElementById(SHEET_ID)?.textContent ?? '';
}

describe('createMutator setStyle', () => {
  it('applies props via the injected sheet (never inline) and marks the element', () => {
    mount('<button id="cta">Buy</button>');
    const el = byId('cta');
    createMutator(document).setStyle(el, { color: 'red', backgroundColor: 'blue' });

    const id = el.getAttribute(MARKER_ATTR);
    expect(id).toMatch(/^dz-\d+$/);
    expect(el.getAttribute('style')).toBeNull();
    expect(sheetText()).toContain(`[${MARKER_ATTR}="${id}"]`);
    expect(sheetText()).toContain('color: red !important');
    expect(sheetText()).toContain('background-color: blue !important'); // camelCase -> kebab
  });

  it('undo removes the rule and the marker', () => {
    mount('<button id="cta">Buy</button>');
    const el = byId('cta');
    const mutation = createMutator(document).setStyle(el, { color: 'red' });
    mutation.undo();
    expect(el.hasAttribute(MARKER_ATTR)).toBe(false);
    expect(sheetText()).toBe('');
  });

  it('merges a second setStyle into one rule and unwinds to the first', () => {
    mount('<button id="cta">Buy</button>');
    const el = byId('cta');
    const mutator = createMutator(document);
    mutator.setStyle(el, { color: 'red' });
    const second = mutator.setStyle(el, { color: 'green', fontSize: '20px' });

    expect(sheetText()).toContain('color: green !important');
    expect(sheetText()).toContain('font-size: 20px !important');

    second.undo();
    expect(sheetText()).toContain('color: red !important'); // reverts to the first value
    expect(sheetText()).not.toContain('font-size'); // the prop second added is dropped
    expect(el.hasAttribute(MARKER_ATTR)).toBe(true); // first override still active
  });

  it('reports the applied value as computed', () => {
    mount('<button id="cta">Buy</button>');
    const mutation = createMutator(document).setStyle(byId('cta'), { color: 'rgb(1, 2, 3)' });
    expect(mutation.computed.color).toBe('rgb(1, 2, 3)');
    expect(mutation.kind).toBe('setStyle');
    expect(mutation.ruleId).toMatch(/^dz-\d+$/);
  });
});

describe('createMutator setText / setAttr', () => {
  it('setText replaces text and undo restores it', () => {
    mount('<p id="t">before</p>');
    const el = byId('t');
    const mutation = createMutator(document).setText(el, 'after');
    expect(el.textContent).toBe('after');
    expect(mutation.before).toBe('before');
    mutation.undo();
    expect(el.textContent).toBe('before');
  });

  it('setText round-trips child structure on undo (not just flattened text)', () => {
    mount('<p id="t">Hello <b>world</b><i>!</i></p>');
    const el = byId('t');
    const mutation = createMutator(document).setText(el, 'replaced');

    expect(el.textContent).toBe('replaced');
    expect(el.children).toHaveLength(0); // visible text replaced
    expect(mutation.before).toBe('Hello <b>world</b><i>!</i>'); // full markup captured, not lossy
    mutation.undo();
    expect(el.innerHTML).toBe('Hello <b>world</b><i>!</i>'); // structure restored, not collapsed
    expect(el.querySelector('b')?.textContent).toBe('world');
  });

  it('setAttr adds a new attribute and undo removes it', () => {
    mount('<a id="l">x</a>');
    const el = byId('l');
    const mutation = createMutator(document).setAttr(el, 'href', '/home');
    expect(el.getAttribute('href')).toBe('/home');
    mutation.undo();
    expect(el.hasAttribute('href')).toBe(false);
  });

  it('setAttr restores a prior attribute value on undo', () => {
    mount('<a id="l" href="/old">x</a>');
    const el = byId('l');
    const mutation = createMutator(document).setAttr(el, 'href', '/new');
    expect(el.getAttribute('href')).toBe('/new');
    mutation.undo();
    expect(el.getAttribute('href')).toBe('/old');
  });

  it('setAttr records the attribute name in the event (self-describing, like setStyle)', () => {
    mount('<a id="l" href="/old">x</a>');
    const m = createMutator(document).setAttr(byId('l'), 'href', '/new');
    // before/after carry the name so #9/#10 can reconstruct WHICH attribute changed, not just its value.
    expect(JSON.parse(m.before)).toEqual({ href: '/old' });
    expect(JSON.parse(m.after)).toEqual({ href: '/new' });
  });

  it('setAttr encodes an absent prior attribute as null', () => {
    mount('<a id="l">x</a>');
    const m = createMutator(document).setAttr(byId('l'), 'data-x', '1');
    expect(JSON.parse(m.before)).toEqual({ 'data-x': null });
    expect(JSON.parse(m.after)).toEqual({ 'data-x': '1' });
  });

  it('setAttr throws on a denied write and does not touch the DOM (safe at source)', () => {
    mount('<a id="l">x</a>');
    const el = byId('l');
    const mutator = createMutator(document);
    expect(() => mutator.setAttr(el, 'onclick', 'steal()')).toThrow(/event handler/);
    expect(() => mutator.setAttr(el, 'href', 'javascript:alert(1)')).toThrow(/javascript:/);
    expect(() => mutator.setAttr(el, 'src', 'https://cdn/x.js')).toThrow(/remote resource/);
    expect(el.hasAttribute('onclick')).toBe(false);
    expect(el.hasAttribute('src')).toBe(false);
    expect(el.hasAttribute('href')).toBe(false);
  });
});

describe('attrDenyReason (setAttr security deny-list)', () => {
  it('allows safe attribute writes', () => {
    expect(attrDenyReason('href', '/home')).toBeNull();
    expect(attrDenyReason('href', 'https://example.com')).toBeNull();
    expect(attrDenyReason('data-id', '42')).toBeNull(); // data-* is not the bare `data` attr
    expect(attrDenyReason('alt', 'a photo')).toBeNull();
    // `javascript:` is inert in a non-navigational attribute, so it must NOT false-refuse legit copy.
    expect(attrDenyReason('alt', 'JavaScript: The Good Parts')).toBeNull();
    expect(attrDenyReason('title', 'javascript: a language')).toBeNull();
    expect(attrDenyReason('title', 'javascript is a language')).toBeNull();
  });

  it('refuses on* event-handler attributes regardless of casing', () => {
    expect(attrDenyReason('onclick', 'x()')).toContain('event handler');
    expect(attrDenyReason('OnError', 'x()')).toContain('event handler');
    expect(attrDenyReason('onmouseover', 'x()')).toBeTruthy();
  });

  it('refuses the remote-load / framed-script attribute names outright', () => {
    expect(attrDenyReason('src', 'https://cdn.example/x.js')).toContain('remote resource');
    expect(attrDenyReason('SRC', '/local.png')).toBeTruthy(); // case-insensitive
    expect(attrDenyReason('srcset', 'https://cdn/x.png 2x')).toBeTruthy();
    expect(attrDenyReason('poster', 'https://cdn/p.png')).toBeTruthy();
    expect(attrDenyReason('ping', 'https://track/beacon')).toBeTruthy();
    expect(attrDenyReason('data', 'https://evil/x.html')).toBeTruthy(); // <object data> runs framed JS
    expect(attrDenyReason('srcdoc', '<script>x()</script>')).toContain('inject');
  });

  it('refuses writes to the internal setStyle marker', () => {
    expect(attrDenyReason(MARKER_ATTR, 'dz-99')).toContain('reserved');
  });

  it('refuses javascript: URLs in navigational attributes (whitespace/control-char tolerant)', () => {
    expect(attrDenyReason('href', 'javascript:alert(1)')).toContain('javascript:');
    expect(attrDenyReason('href', '  JavaScript:alert(1)')).toBeTruthy(); // leading ws + casing
    expect(attrDenyReason('href', 'java\tscript:alert(1)')).toBeTruthy(); // embedded control char
    expect(attrDenyReason('xlink:href', 'javascript:x')).toBeTruthy();
    expect(attrDenyReason('formaction', 'javascript:x')).toBeTruthy();
    expect(attrDenyReason('action', 'javascript:x')).toBeTruthy();
  });
});

describe('createMutator class toggles', () => {
  it('addClass adds a new class and undo removes it', () => {
    mount('<div id="d"></div>');
    const el = byId('d');
    const mutation = createMutator(document).addClass(el, 'hero');
    expect(el.classList.contains('hero')).toBe(true);
    mutation.undo();
    expect(el.classList.contains('hero')).toBe(false);
  });

  it('addClass undo keeps a class that already existed', () => {
    mount('<div id="d" class="hero"></div>');
    const el = byId('d');
    createMutator(document).addClass(el, 'hero').undo();
    expect(el.classList.contains('hero')).toBe(true);
  });

  it('removeClass removes a class and undo restores it', () => {
    mount('<div id="d" class="a b"></div>');
    const el = byId('d');
    const mutation = createMutator(document).removeClass(el, 'b');
    expect(el.classList.contains('b')).toBe(false);
    mutation.undo();
    expect(el.classList.contains('b')).toBe(true);
  });

  it('removeClass undo does not add a class that was never present', () => {
    mount('<div id="d" class="a"></div>');
    const el = byId('d');
    createMutator(document).removeClass(el, 'ghost').undo();
    expect(el.classList.contains('ghost')).toBe(false);
  });
});

describe('createMutator structural edits', () => {
  it('insertNode inserts and undo removes', () => {
    mount('<ul id="list"><li>one</li></ul>');
    const ref = byId('list');
    const mutation = createMutator(document).insertNode(ref, '<li>two</li>', 'beforeend');
    expect(ref.querySelectorAll('li')).toHaveLength(2);
    expect(mutation.computed.html).toBe('<li>two</li>');
    mutation.undo();
    expect(ref.querySelectorAll('li')).toHaveLength(1);
  });

  it('insertNode inserts EVERY top-level node and undo removes them all', () => {
    mount('<ul id="list"><li>one</li></ul>');
    const ref = byId('list');
    const mutation = createMutator(document).insertNode(
      ref,
      '<li>two</li><li>three</li>',
      'beforeend',
    );
    expect(ref.querySelectorAll('li')).toHaveLength(3); // both siblings inserted, not just the first
    expect(mutation.after).toBe('<li>two</li><li>three</li>'); // full set serialized
    mutation.undo();
    expect(ref.querySelectorAll('li')).toHaveLength(1);
  });

  it('insertNode inserts a bare text node without wrapping it in a span', () => {
    mount('<p id="p">Hi </p>');
    const ref = byId('p');
    const mutation = createMutator(document).insertNode(ref, 'there', 'beforeend');
    expect(ref.querySelector('span')).toBeNull(); // no phantom wrapper
    expect(ref.textContent).toBe('Hi there');
    mutation.undo();
    expect(ref.textContent).toBe('Hi ');
  });

  it('insertNode strips inline on* handlers from imported markup (CSP-safe)', () => {
    mount('<div id="host"></div>');
    const ref = byId('host');
    createMutator(document).insertNode(
      ref,
      '<img src="x" onerror="window.__pwned=1" onload="1">',
      'beforeend',
    );
    const img = ref.querySelector('img');
    expect(img?.hasAttribute('onerror')).toBe(false);
    expect(img?.hasAttribute('onload')).toBe(false);
    expect(img?.getAttribute('src')).toBe('x'); // resource attr preserved
  });

  it('moveNode relocates and undo restores the original position', () => {
    mount('<div id="a"><span id="s">x</span></div><div id="b"></div>');
    const [s, a, b] = [byId('s'), byId('a'), byId('b')];
    const mutation = createMutator(document).moveNode(s, b, 'beforeend');
    expect(b.contains(s)).toBe(true);
    expect(a.contains(s)).toBe(false);
    mutation.undo();
    expect(a.contains(s)).toBe(true);
    expect(b.contains(s)).toBe(false);
  });

  it('removeNode removes and undo re-inserts at the same spot', () => {
    mount('<ul id="list"><li id="x">x</li><li id="y">y</li></ul>');
    const list = byId('list');
    const mutation = createMutator(document).removeNode(byId('x'));
    expect(document.getElementById('x')).toBeNull();
    mutation.undo();
    expect(Array.from(list.querySelectorAll('li')).map((li) => li.id)).toEqual(['x', 'y']);
  });
});

describe('createMutator page ops', () => {
  it('injectCss appends a stylesheet and undo removes it', () => {
    mount('<div></div>');
    const mutation = createMutator(document).injectCss('.x{color:red}');
    expect(document.querySelectorAll('style.dz-designer-injected')).toHaveLength(1);
    mutation.undo();
    expect(document.querySelectorAll('style.dz-designer-injected')).toHaveLength(0);
  });

  it('setViewport constrains the document width and undo restores prior style', () => {
    mount('<div></div>');
    const root = document.documentElement;
    const mutation = createMutator(document).setViewport({ width: 375 });
    expect(root.style.getPropertyValue('max-width')).toBe('375px');
    expect(mutation.computed).toEqual({ width: 375, height: null });
    mutation.undo();
    expect(root.style.getPropertyValue('max-width')).toBe('');
  });
});
