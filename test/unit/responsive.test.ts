import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Box,
  type ResponsiveProbe,
  scanClipping,
  scanMediaScaling,
  scanNav,
  scanOverflow,
  scanResponsive,
  scanTapTargets,
  scanTextLegibility,
  scanViewportUnits,
} from '@/dom/responsive';

// jsdom has no layout engine, so every scan reads geometry through an injected probe. Tests stash
// per-element metrics in a WeakMap and hand the scans a fake probe that reads them; unset props fall
// back to sensible "visible, static, 16px" defaults so a fixture only declares what it's asserting.

interface Metrics {
  box: Box;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  computed: Record<string, string>;
  intrinsicWidth: number;
}

const store = new WeakMap<Element, Partial<Metrics>>();

const DEFAULT_COMPUTED: Record<string, string> = {
  display: 'block',
  visibility: 'visible',
  position: 'static',
  'max-width': 'none',
  'overflow-x': 'visible',
  'overflow-y': 'visible',
  'text-overflow': 'clip',
  'font-size': '16px',
};

function box(width: number, height: number, left = 0, top = 0): Box {
  return { width, height, left, top, right: left + width, bottom: top + height };
}

function setM(el: Element, m: Partial<Metrics>): Element {
  store.set(el, { ...store.get(el), ...m });
  return el;
}

function fakeProbe(vw: number, vh = 800): ResponsiveProbe {
  const m = (el: Element): Partial<Metrics> => store.get(el) ?? {};
  return {
    viewportWidth: () => vw,
    viewportHeight: () => vh,
    rect: (el) => m(el).box ?? box(10, 10),
    scrollWidth: (el) => m(el).scrollWidth ?? m(el).box?.width ?? 0,
    clientWidth: (el) => m(el).clientWidth ?? m(el).box?.width ?? 0,
    scrollHeight: (el) => m(el).scrollHeight ?? m(el).box?.height ?? 0,
    clientHeight: (el) => m(el).clientHeight ?? m(el).box?.height ?? 0,
    computed: (el, prop) => m(el).computed?.[prop] ?? DEFAULT_COMPUTED[prop] ?? '',
    intrinsicWidth: (el) => m(el).intrinsicWidth ?? 0,
  };
}

function mount(html: string): void {
  document.body.innerHTML = html;
}

function q(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`fixture missing: ${selector}`);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('scanOverflow', () => {
  it('flags a page that scrolls sideways (scrollWidth > clientWidth)', () => {
    mount('<main>content</main>');
    setM(document.documentElement, { scrollWidth: 900, clientWidth: 375 });

    const [finding] = scanOverflow(document, window, { probe: fakeProbe(375) });

    expect(finding?.category).toBe('overflow');
    expect(finding?.severity).toBe('serious');
    expect(finding?.detail).toContain('900px');
    expect(finding?.selector.value).toBeTruthy();
  });

  it('flags an element rendered wider than the viewport', () => {
    mount('<div id="wide">too wide</div>');
    setM(q('#wide'), { box: box(600, 40) });

    const findings = scanOverflow(document, window, { probe: fakeProbe(375) });

    expect(findings.some((f) => f.detail.includes('<div>') && f.detail.includes('600px'))).toBe(
      true,
    );
  });

  it('is quiet when content fits the viewport', () => {
    mount('<div id="ok">fits</div>');
    setM(document.documentElement, { scrollWidth: 375, clientWidth: 375 });
    setM(q('#ok'), { box: box(300, 40) });

    expect(scanOverflow(document, window, { probe: fakeProbe(375) })).toEqual([]);
  });
});

describe('scanMediaScaling', () => {
  it('flags media wider than the viewport as not scaling down', () => {
    mount('<img id="hero" src="/h.jpg" alt="hero" />');
    setM(q('#hero'), { box: box(1200, 400) });

    const [finding] = scanMediaScaling(document, window, { probe: fakeProbe(375) });

    expect(finding?.category).toBe('media-scaling');
    expect(finding?.severity).toBe('serious');
    expect(finding?.detail).toContain('1200px');
  });

  it('flags an intrinsically large image with no max-width', () => {
    mount('<img id="big" src="/b.jpg" alt="big" />');
    setM(q('#big'), {
      box: box(300, 200),
      intrinsicWidth: 2000,
      computed: { 'max-width': 'none' },
    });

    const [finding] = scanMediaScaling(document, window, { probe: fakeProbe(375) });

    expect(finding?.severity).toBe('moderate');
    expect(finding?.detail).toContain('2000px');
  });

  it('does not flag a constrained image that fits', () => {
    mount('<img id="resp" src="/r.jpg" alt="resp" />');
    setM(q('#resp'), {
      box: box(340, 200),
      intrinsicWidth: 2000,
      computed: { 'max-width': '100%' },
    });

    expect(scanMediaScaling(document, window, { probe: fakeProbe(375) })).toEqual([]);
  });
});

describe('scanTapTargets', () => {
  it('flags an interactive element below the 44px touch target', () => {
    mount('<button id="x">×</button>');
    setM(q('#x'), { box: box(20, 20) });

    const [finding] = scanTapTargets(document, window, { probe: fakeProbe(375) });

    expect(finding?.category).toBe('tap-target');
    expect(finding?.detail).toContain('20×20px');
    expect(finding?.detail).toContain('44×44px');
  });

  it('respects a custom minTapPx', () => {
    mount('<a id="a" href="/">link</a>');
    setM(q('#a'), { box: box(30, 30) });

    expect(scanTapTargets(document, window, { probe: fakeProbe(375), minTapPx: 24 })).toEqual([]);
  });

  it('passes a comfortably sized target', () => {
    mount('<button id="ok">Go</button>');
    setM(q('#ok'), { box: box(120, 48) });

    expect(scanTapTargets(document, window, { probe: fakeProbe(375) })).toEqual([]);
  });

  it('flags two overlapping leaf controls', () => {
    mount('<nav><a id="a" href="/1">1</a><a id="b" href="/2">2</a></nav>');
    setM(q('#a'), { box: box(100, 48, 0, 0) });
    setM(q('#b'), { box: box(100, 48, 50, 0) }); // overlaps #a by 50px

    const overlap = scanTapTargets(document, window, { probe: fakeProbe(375) }).find((f) =>
      f.detail.includes('overlap'),
    );

    expect(overlap?.category).toBe('tap-target');
  });

  it('skips wrappers that contain another control', () => {
    mount('<div id="wrap" onclick="x()"><button id="inner">Go</button></div>');
    setM(q('#wrap'), { box: box(10, 10) });
    setM(q('#inner'), { box: box(120, 48) });

    // The 10x10 wrapper would be undersized, but it is not a leaf target — only #inner is measured.
    expect(scanTapTargets(document, window, { probe: fakeProbe(375) })).toEqual([]);
  });
});

describe('scanTextLegibility', () => {
  it('flags text below the legible floor', () => {
    mount('<p id="fine">tiny print</p>');
    setM(q('#fine'), { computed: { 'font-size': '9px' } });

    const [finding] = scanTextLegibility(document, window, { probe: fakeProbe(375) });

    expect(finding?.category).toBe('text-legibility');
    expect(finding?.severity).toBe('moderate');
    expect(finding?.detail).toContain('9px');
  });

  it('passes legible body text', () => {
    mount('<p id="body">readable copy</p>');
    setM(q('#body'), { computed: { 'font-size': '16px' } });

    expect(scanTextLegibility(document, window, { probe: fakeProbe(375) })).toEqual([]);
  });
});

describe('scanClipping', () => {
  it('flags an overflow-hidden box whose content is cut off', () => {
    mount('<div id="clip">cut off content</div>');
    setM(q('#clip'), {
      box: box(200, 40),
      clientWidth: 200,
      scrollWidth: 500,
      computed: { 'overflow-x': 'hidden' },
    });

    const [finding] = scanClipping(document, window, { probe: fakeProbe(375) });

    expect(finding?.category).toBe('clip');
    expect(finding?.severity).toBe('moderate');
  });

  it('calls out ellipsis truncation as a minor finding', () => {
    mount('<div id="trunc">a very long single line label</div>');
    setM(q('#trunc'), {
      box: box(120, 20),
      clientWidth: 120,
      scrollWidth: 400,
      computed: { 'overflow-x': 'hidden', 'text-overflow': 'ellipsis' },
    });

    const [finding] = scanClipping(document, window, { probe: fakeProbe(375) });

    expect(finding?.severity).toBe('minor');
    expect(finding?.detail).toContain('ellipsis');
  });

  it('ignores a scrollable (overflow:auto) container', () => {
    mount('<div id="scroll">scrollable</div>');
    setM(q('#scroll'), {
      box: box(200, 40),
      clientWidth: 200,
      scrollWidth: 500,
      computed: { 'overflow-x': 'auto' },
    });

    expect(scanClipping(document, window, { probe: fakeProbe(375) })).toEqual([]);
  });
});

describe('scanNav', () => {
  it('flags a mobile nav with several links and no menu toggle', () => {
    mount('<nav><a href="/1">1</a><a href="/2">2</a><a href="/3">3</a><a href="/4">4</a></nav>');

    const [finding] = scanNav(document, window, { probe: fakeProbe(375) });

    expect(finding?.category).toBe('nav');
    expect(finding?.detail).toContain('4 nav links');
  });

  it('is quiet when a hamburger toggle is present', () => {
    mount(
      '<header><nav><a href="/1">1</a><a href="/2">2</a><a href="/3">3</a><a href="/4">4</a>' +
        '<button aria-label="Open menu">≡</button></nav></header>',
    );

    expect(scanNav(document, window, { probe: fakeProbe(375) })).toEqual([]);
  });

  it('does not run above the mobile breakpoint', () => {
    mount('<nav><a href="/1">1</a><a href="/2">2</a><a href="/3">3</a><a href="/4">4</a></nav>');

    expect(scanNav(document, window, { probe: fakeProbe(1280) })).toEqual([]);
  });
});

describe('scanViewportUnits', () => {
  it('flags inline 100vh height as a mobile-chrome hazard', () => {
    mount('<section id="hero" style="min-height:100vh">hero</section>');

    const [finding] = scanViewportUnits(document, window, { probe: fakeProbe(375) });

    expect(finding?.category).toBe('viewport-unit');
    expect(finding?.detail).toContain('100vh');
  });

  it('flags overlapping fixed/sticky elements', () => {
    mount('<div id="top">top</div><div id="bar">bar</div>');
    setM(q('#top'), { box: box(375, 60, 0, 0), computed: { position: 'fixed' } });
    setM(q('#bar'), { box: box(375, 60, 0, 30), computed: { position: 'sticky' } });

    const overlap = scanViewportUnits(document, window, { probe: fakeProbe(375) }).find((f) =>
      f.detail.includes('overlap'),
    );

    expect(overlap?.severity).toBe('moderate');
  });

  it('does not flag a width in vw or a non-vh height', () => {
    mount('<div id="a" style="width:100vw"></div><div id="b" style="height:200px"></div>');

    expect(scanViewportUnits(document, window, { probe: fakeProbe(375) })).toEqual([]);
  });
});

describe('scanResponsive', () => {
  it('merges sub-scans, sorts most-severe-first, and reports the viewport width', () => {
    mount('<img id="hero" src="/h.jpg" alt="hero" /><p id="fine">legal</p>');
    setM(q('#hero'), { box: box(1000, 300) }); // serious media-scaling
    setM(q('#fine'), { computed: { 'font-size': '9px' } }); // moderate text-legibility

    const result = scanResponsive(document, window, { probe: fakeProbe(375) });

    expect(result.viewportWidth).toBe(375);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    expect(result.findings[0]?.severity).toBe('serious');
    expect(result.findings.map((f) => f.category)).toContain('media-scaling');
    expect(result.findings.map((f) => f.category)).toContain('text-legibility');
    for (const finding of result.findings) {
      expect(finding.selector.value).toBeTruthy();
    }
  });

  it('returns an empty finding list for a clean, fitting page', () => {
    mount('<main id="m"><p id="p">readable copy here</p></main>');
    setM(document.documentElement, { scrollWidth: 375, clientWidth: 375 });
    setM(q('#m'), { box: box(360, 400) });
    setM(q('#p'), { box: box(340, 40), computed: { 'font-size': '16px' } });

    expect(scanResponsive(document, window, { probe: fakeProbe(375) }).findings).toEqual([]);
  });
});
