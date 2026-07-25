import { afterEach, describe, expect, it } from 'vitest';
import { clipVerdict, isFixedPosition, isInnerScrollContainer } from '@/dom/read';

// Reveal-planning helpers for the element-screenshot choreography (#137 items 2/3/6) — the pure
// DOM logic content.ts wires into its scroll/settle decision. jsdom reports 0 for every box size
// and a zero rect, so fixtures fake the geometry each helper reads. Viewport is jsdom's default
// 1024x768. Overflow fixtures set the overflow-x/y LONGHANDS — cssstyle doesn't propagate the
// `overflow` shorthand to them.

function mount(html: string): void {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
}

afterEach(() => {
  // Some fixtures style/stub document-level objects (body overflow, scrollingElement) — reset so
  // they can't leak into a later test in this file.
  document.body.style.cssText = '';
  Reflect.deleteProperty(document, 'scrollingElement');
});

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fixture missing: #${id}`);
  return el;
}

interface RectLike {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function fakeBox(
  el: HTMLElement,
  box: {
    rect?: RectLike;
    clientWidth?: number;
    clientHeight?: number;
    clientTop?: number;
    clientLeft?: number;
    scrollWidth?: number;
    scrollHeight?: number;
  },
): void {
  const rect = box.rect ?? { top: 0, left: 0, bottom: 0, right: 0 };
  const domRect = {
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  };
  Object.defineProperty(el, 'getBoundingClientRect', { value: () => domRect, configurable: true });
  for (const key of [
    'clientWidth',
    'clientHeight',
    'clientTop',
    'clientLeft',
    'scrollWidth',
    'scrollHeight',
  ] as const) {
    Object.defineProperty(el, key, { value: box[key] ?? 0, configurable: true });
  }
}

describe('clipVerdict', () => {
  it('is fully painted for an on-screen element with no clipping ancestor', () => {
    mount('<div id="wrap"><div id="target"></div></div>');
    fakeBox(byId('target'), { rect: { top: 10, left: 10, bottom: 110, right: 110 } });
    expect(clipVerdict(byId('target'), window)).toEqual({
      fullyPainted: true,
      neverPaintable: false,
    });
  });

  it('is fully painted inside a scroll container whose client rect contains the element (#137 item 2 — the reveal AND settle are then skipped)', () => {
    mount('<div id="scroller" style="overflow-y: auto"><div id="target"></div></div>');
    fakeBox(byId('scroller'), {
      rect: { top: 0, left: 0, bottom: 300, right: 300 },
      clientWidth: 300,
      clientHeight: 300,
      scrollHeight: 900,
    });
    fakeBox(byId('target'), { rect: { top: 10, left: 10, bottom: 110, right: 110 } });
    expect(clipVerdict(byId('target'), window)).toEqual({
      fullyPainted: true,
      neverPaintable: false,
    });
  });

  it('is not fully painted when a scroll container clips part of the element (reveal still runs)', () => {
    mount('<div id="scroller" style="overflow-y: auto"><div id="target"></div></div>');
    fakeBox(byId('scroller'), {
      rect: { top: 0, left: 0, bottom: 300, right: 300 },
      clientWidth: 300,
      clientHeight: 300,
      scrollHeight: 900,
    });
    fakeBox(byId('target'), { rect: { top: 250, left: 10, bottom: 350, right: 110 } });
    expect(clipVerdict(byId('target'), window)).toEqual({
      fullyPainted: false,
      neverPaintable: false,
    });
  });

  it('is recoverable (not neverPaintable) when a SCROLL container clips the element to empty', () => {
    mount('<div id="scroller" style="overflow-y: auto"><div id="target"></div></div>');
    fakeBox(byId('scroller'), {
      rect: { top: 0, left: 0, bottom: 300, right: 300 },
      clientWidth: 300,
      clientHeight: 300,
      scrollHeight: 900,
    });
    fakeBox(byId('target'), { rect: { top: 400, left: 10, bottom: 500, right: 110 } });
    expect(clipVerdict(byId('target'), window)).toEqual({
      fullyPainted: false,
      neverPaintable: false,
    });
  });

  it('is neverPaintable when an overflow:clip ancestor clips the element to empty and nothing between them scrolls (#137 item 2 — error, not wrong pixels)', () => {
    mount('<div id="clipper" style="overflow-y: clip"><div id="target"></div></div>');
    fakeBox(byId('clipper'), {
      rect: { top: 0, left: 0, bottom: 300, right: 300 },
      clientWidth: 300,
      clientHeight: 300,
      scrollHeight: 900, // overflows, yet NOT a scroll container (overflow:clip)
    });
    fakeBox(byId('target'), { rect: { top: 400, left: 10, bottom: 500, right: 110 } });
    expect(clipVerdict(byId('target'), window)).toEqual({
      fullyPainted: false,
      neverPaintable: true,
    });
  });

  it('stays recoverable when a scroll container sits between the element and the clip-only ancestor (scrolling it moves the element back inside)', () => {
    mount(
      '<div id="clipper" style="overflow-y: clip"><div id="scroller" style="overflow-y: auto"><div id="target"></div></div></div>',
    );
    fakeBox(byId('clipper'), {
      rect: { top: 0, left: 0, bottom: 300, right: 300 },
      clientWidth: 300,
      clientHeight: 300,
    });
    fakeBox(byId('scroller'), {
      rect: { top: 0, left: 0, bottom: 600, right: 300 },
      clientWidth: 300,
      clientHeight: 600,
      scrollHeight: 1200,
    });
    fakeBox(byId('target'), { rect: { top: 400, left: 10, bottom: 500, right: 110 } });
    expect(clipVerdict(byId('target'), window)).toEqual({
      fullyPainted: false,
      neverPaintable: false,
    });
  });

  it('clips per axis: a y-clip-only ancestor cannot empty the band horizontally', () => {
    mount('<div id="clipper" style="overflow-y: clip"><div id="target"></div></div>');
    fakeBox(byId('clipper'), {
      rect: { top: 0, left: 0, bottom: 300, right: 100 },
      clientWidth: 100,
      clientHeight: 300,
    });
    // Beyond the clipper only on X — y-clip leaves the horizontal band alone.
    fakeBox(byId('target'), { rect: { top: 10, left: 150, bottom: 110, right: 250 } });
    expect(clipVerdict(byId('target'), window)).toEqual({
      fullyPainted: true,
      neverPaintable: false,
    });
  });

  it('is not fully painted for an off-viewport element (the document-scroll path owns that reveal)', () => {
    mount('<div id="wrap"><div id="target"></div></div>');
    fakeBox(byId('target'), { rect: { top: 800, left: 10, bottom: 900, right: 110 } });
    expect(clipVerdict(byId('target'), window)).toEqual({
      fullyPainted: false,
      neverPaintable: false,
    });
  });

  it('treats body as a clipper (the walk includes it, stopping before documentElement)', () => {
    document.body.style.setProperty('overflow-y', 'clip');
    mount('<div id="target"></div>');
    // jsdom body: zero client box → clips everything to empty; not scrollable (0 sizes).
    fakeBox(byId('target'), { rect: { top: 400, left: 10, bottom: 500, right: 110 } });
    expect(clipVerdict(byId('target'), window).neverPaintable).toBe(true);
  });

  it('skips the walk for a zero-size rect (the crop fallback owns degenerate rects)', () => {
    mount('<div id="clipper" style="overflow-y: clip"><div id="target"></div></div>');
    fakeBox(byId('clipper'), {
      rect: { top: 0, left: 0, bottom: 300, right: 300 },
      clientWidth: 300,
      clientHeight: 300,
    });
    fakeBox(byId('target'), { rect: { top: 10, left: 10, bottom: 10, right: 10 } });
    expect(clipVerdict(byId('target'), window)).toEqual({
      fullyPainted: true,
      neverPaintable: false,
    });
  });
});

describe('isInnerScrollContainer', () => {
  it('counts any non-document container', () => {
    mount('<div id="inner"></div>');
    expect(isInnerScrollContainer(byId('inner'), document)).toBe(true);
  });

  it('never counts documentElement', () => {
    expect(isInnerScrollContainer(document.documentElement, document)).toBe(false);
  });

  it('skips body while it is not the document scrollingElement', () => {
    // jsdom leaves scrollingElement unimplemented (undefined ≠ body) — the standards-mode shape.
    expect(isInnerScrollContainer(document.body, document)).toBe(false);
  });

  it('counts body when it IS the scrollingElement — the quirks-style inner-scroller setup (#137 item 3)', () => {
    Object.defineProperty(document, 'scrollingElement', {
      value: document.body,
      configurable: true,
    });
    expect(isInnerScrollContainer(document.body, document)).toBe(true);
  });
});

describe('isFixedPosition', () => {
  it('is false for a statically positioned element', () => {
    mount('<div id="s"></div>');
    expect(isFixedPosition(byId('s'))).toBe(false);
  });

  it('is true for position:fixed — the caller skips the no-op scroll+settle (#137 item 6)', () => {
    mount('<div id="f" style="position: fixed"></div>');
    expect(isFixedPosition(byId('f'))).toBe(true);
  });
});
