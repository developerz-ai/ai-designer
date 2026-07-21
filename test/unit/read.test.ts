import { describe, expect, it } from 'vitest';
import {
  a11ySnapshot,
  cropBox,
  getStyles,
  needsScrollIntoView,
  pageMetrics,
  planStitch,
  query,
  queryOne,
  screenshotRect,
  scrollableAncestors,
  scrollImprovesCapture,
} from '@/dom/read';
import type { PageMetrics } from '@/shared/messages';

function mount(html: string): void {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fixture missing: #${id}`);
  return el;
}

describe('query', () => {
  it('returns a stable, non-fragile selector for a data-testid element', () => {
    mount('<button data-testid="cta">Buy</button>');
    const { matches } = query(document, 'button');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.strategy).toBe('data-attr');
    expect(matches[0]?.value).toBe('[data-testid="cta"]');
    expect(matches[0]?.fragile).toBe(false);
  });

  it('flags an anonymous element with a fragile css-path', () => {
    mount('<section id="s"><span></span><span></span></section>');
    const { matches } = query(document, '#s span:nth-of-type(2)');
    expect(matches[0]?.strategy).toBe('css-path');
    expect(matches[0]?.fragile).toBe(true);
  });

  it('resolves one selector per match', () => {
    mount('<ul id="l"><li>a</li><li>b</li></ul>');
    expect(query(document, '#l li').matches).toHaveLength(2);
  });

  it('never throws on an invalid selector', () => {
    mount('<div></div>');
    expect(query(document, ':::bad').matches).toEqual([]);
    expect(queryOne(document, ':::bad')).toBeNull();
  });

  it('queryOne returns the first match', () => {
    mount('<p class="x">one</p><p class="x">two</p>');
    expect(queryOne(document, '.x')?.textContent).toBe('one');
  });
});

describe('getStyles', () => {
  it('projects the computed subset and reads a set value', () => {
    mount('<p id="p" style="display: flex">x</p>');
    expect(getStyles(byId('p'), ['display']).styles.display).toBe('flex');
  });

  it('drops empty props', () => {
    mount('<p id="p">x</p>');
    expect(getStyles(byId('p'), ['nonexistent-prop']).styles).toEqual({});
  });

  it('defaults to the relevant-props projection', () => {
    mount('<p id="p" style="display: block">x</p>');
    const { styles } = getStyles(byId('p'));
    expect(styles.display).toBe('block');
  });
});

describe('a11ySnapshot', () => {
  it('maps implicit roles and accessible names', () => {
    mount('<nav id="n"><a href="/">Home</a></nav>');
    const { tree } = a11ySnapshot(byId('n'));
    expect(tree.role).toBe('navigation');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.role).toBe('link');
    expect(tree.children[0]?.name).toBe('Home');
  });

  it('prefers aria-label for the accessible name', () => {
    mount('<button id="b" aria-label="Close dialog">x</button>');
    expect(a11ySnapshot(byId('b')).tree.name).toBe('Close dialog');
  });

  it('skips aria-hidden and non-visual nodes', () => {
    mount(
      '<div id="d"><span>seen</span><span aria-hidden="true">gone</span><script>1</script></div>',
    );
    const { tree } = a11ySnapshot(byId('d'));
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.name).toBe('seen');
  });

  it('bounds recursion depth', () => {
    mount('<div id="d"><div><div><div>deep</div></div></div></div>');
    const { tree } = a11ySnapshot(byId('d'), 1);
    expect(tree.children[0]?.children).toHaveLength(0);
  });
});

describe('screenshotRect', () => {
  it('returns the element rect and devicePixelRatio', () => {
    mount('<div id="d">x</div>');
    const shot = screenshotRect(byId('d'));
    expect(shot.rect).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    });
    expect(typeof shot.devicePixelRatio).toBe('number');
  });

  it('falls back to the viewport rect when no element is given', () => {
    const shot = screenshotRect();
    expect(shot.rect.width).toBe(window.innerWidth);
    expect(shot.rect.height).toBe(window.innerHeight);
  });
});

describe('needsScrollIntoView', () => {
  it('is false for an element fully inside the viewport', () => {
    expect(needsScrollIntoView({ top: 10, left: 10, bottom: 100, right: 100 }, 1024, 768)).toBe(
      false,
    );
  });

  it('is true below the fold, above the fold, or clipped at either side', () => {
    expect(needsScrollIntoView({ top: 800, left: 10, bottom: 900, right: 100 }, 1024, 768)).toBe(
      true,
    );
    expect(needsScrollIntoView({ top: -50, left: 10, bottom: 20, right: 100 }, 1024, 768)).toBe(
      true,
    );
    expect(needsScrollIntoView({ top: 10, left: -5, bottom: 100, right: 40 }, 1024, 768)).toBe(
      true,
    );
    expect(needsScrollIntoView({ top: 10, left: 10, bottom: 100, right: 1200 }, 1024, 768)).toBe(
      true,
    );
  });
});

describe('scrollableAncestors', () => {
  // jsdom reports 0 for every box size, so fake the four the helper reads.
  function fakeSizes(
    el: HTMLElement,
    sizes: {
      scrollHeight?: number;
      clientHeight?: number;
      scrollWidth?: number;
      clientWidth?: number;
    },
  ): void {
    for (const [key, value] of Object.entries(sizes)) {
      Object.defineProperty(el, key, { value, configurable: true });
    }
  }

  it('returns the scrollable ancestors nearest-first, skipping non-scrollable ones', () => {
    mount(
      '<div id="outer"><div id="mid"><div id="inner"><div id="target"></div></div></div></div>',
    );
    fakeSizes(byId('outer'), { scrollHeight: 900, clientHeight: 200 });
    fakeSizes(byId('mid'), { scrollHeight: 200, clientHeight: 200 });
    fakeSizes(byId('inner'), { scrollWidth: 500, clientWidth: 100 });
    expect(scrollableAncestors(byId('target')).map((a) => a.id)).toEqual(['inner', 'outer']);
  });

  it('is empty when no ancestor scrolls (jsdom default sizes)', () => {
    mount('<div id="wrap"><div id="target"></div></div>');
    expect(scrollableAncestors(byId('target'))).toEqual([]);
  });

  it('walks into shadow roots via the host when the target is shadow-in', () => {
    mount('<div id="host"></div>');
    const shadow = byId('host').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div id="scroller"><div id="inner"></div></div>';
    const scroller = shadow.getElementById('scroller');
    const inner = shadow.getElementById('inner');
    if (!scroller || !inner) throw new Error('shadow fixture missing');
    fakeSizes(scroller, { scrollHeight: 900, clientHeight: 200 });
    expect(scrollableAncestors(inner).map((a) => a.id)).toEqual(['scroller']);
  });

  it('walks the composed tree for slotted elements (assignedSlot before parentElement)', () => {
    mount('<div id="host"><span id="slotted"></span></div>');
    const shadow = byId('host').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div id="shadowscroller"><slot></slot></div>';
    const scroller = shadow.getElementById('shadowscroller');
    if (!scroller) throw new Error('shadow fixture missing');
    fakeSizes(scroller, { scrollHeight: 900, clientHeight: 200 });
    // A slotted element's flat-tree parent chain goes through its slot, so a scrollable container
    // inside the shadow root must be found even though it is NOT a DOM ancestor.
    expect(scrollableAncestors(byId('slotted')).map((a) => a.id)).toContain('shadowscroller');
  });
});

describe('scrollImprovesCapture', () => {
  it('is false for an element fully in view', () => {
    expect(scrollImprovesCapture({ top: 10, left: 10, bottom: 100, right: 100 }, 1024, 768)).toBe(
      false,
    );
  });

  it('is true when a fittable axis is clipped', () => {
    expect(scrollImprovesCapture({ top: 800, left: 10, bottom: 900, right: 100 }, 1024, 768)).toBe(
      true,
    );
    expect(scrollImprovesCapture({ top: 10, left: -5, bottom: 100, right: 40 }, 1024, 768)).toBe(
      true,
    );
  });

  it('is false for a taller-than-viewport element whose top is visible — centering swaps the header for a middle band', () => {
    expect(scrollImprovesCapture({ top: 10, left: 10, bottom: 2000, right: 100 }, 1024, 768)).toBe(
      false,
    );
    expect(scrollImprovesCapture({ top: -50, left: 10, bottom: 2000, right: 100 }, 1024, 768)).toBe(
      false,
    );
  });

  it('is true for an unfittable element when NONE of it is visible — scrolling shows a band of it', () => {
    // Taller than the viewport, entirely below (incl. the exactly-viewport-sized edge).
    expect(scrollImprovesCapture({ top: 800, left: 10, bottom: 2000, right: 100 }, 1024, 768)).toBe(
      true,
    );
    expect(scrollImprovesCapture({ top: 800, left: 10, bottom: 1568, right: 100 }, 1024, 768)).toBe(
      true,
    );
    // Wider than the viewport, entirely to the left.
    expect(
      scrollImprovesCapture({ top: 10, left: -1500, bottom: 100, right: -200 }, 1024, 768),
    ).toBe(true);
  });

  it('is still true for a taller-than-viewport element clipped on a fittable width', () => {
    expect(scrollImprovesCapture({ top: 10, left: -5, bottom: 2000, right: 100 }, 1024, 768)).toBe(
      true,
    );
  });
});

describe('cropBox', () => {
  it('scales a CSS-px rect to device px and clamps to the image', () => {
    // rect 10,20 100x50 @2x → 20,40 200x100, clamped inside a 800x600 frame.
    expect(cropBox({ x: 10, y: 20, width: 100, height: 50 }, 2, 800, 600)).toEqual({
      sx: 20,
      sy: 40,
      sw: 200,
      sh: 100,
    });
  });

  it('clamps width/height that would overflow the frame', () => {
    const box = cropBox({ x: 700, y: 500, width: 400, height: 400 }, 1, 800, 600);
    expect(box).toEqual({ sx: 700, sy: 500, sw: 100, sh: 100 });
  });

  it('returns null for an empty rect (keeps the full frame)', () => {
    expect(cropBox({ x: 0, y: 0, width: 0, height: 100 }, 2, 800, 600)).toBeNull();
  });

  it('returns null when the crop already spans the whole frame (no re-encode)', () => {
    expect(cropBox({ x: 0, y: 0, width: 400, height: 300 }, 2, 800, 600)).toBeNull();
  });

  it('returns null when the rect starts past the image edge', () => {
    expect(cropBox({ x: 900, y: 0, width: 100, height: 100 }, 1, 800, 600)).toBeNull();
  });
});

// --- full-page scroll-stitch geometry ------------------------------------

const metrics = (over: Partial<PageMetrics> = {}): PageMetrics => ({
  scrollWidth: 1000,
  scrollHeight: 1000,
  viewportWidth: 1000,
  viewportHeight: 1000,
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
  ...over,
});

describe('planStitch', () => {
  it('a page that fits the viewport is a single band, no scroll, no overlap', () => {
    const plan = planStitch(metrics({ scrollHeight: 800, viewportHeight: 1000 }));
    expect(plan.bands).toEqual([{ scrollY: 0, srcY: 0, destY: 0, height: 800 }]);
    expect(plan).toMatchObject({ canvasWidth: 1000, canvasHeight: 800 });
  });

  it('tiles a tall page into viewport-height bands and clamps the last scroll to the page bottom', () => {
    // 2500 tall, 1000 viewport → bands at y=0, 1000, and a clamped last at 1500 (not 2000).
    const plan = planStitch(metrics({ scrollHeight: 2500, viewportHeight: 1000 }));
    expect(plan.canvasHeight).toBe(2500);
    expect(plan.bands.map((b) => b.scrollY)).toEqual([0, 1000, 1500]);
    // The clamped last band starts copying below its top (its top rows overlap band 2 → skipped).
    const last = plan.bands.at(-1);
    expect(last).toEqual({ scrollY: 1500, srcY: 500, destY: 2000, height: 500 });
  });

  it('scales every band by devicePixelRatio (canvas + copy rects are device px)', () => {
    const plan = planStitch(
      metrics({ scrollHeight: 1500, viewportHeight: 1000, devicePixelRatio: 2 }),
    );
    expect(plan.canvasWidth).toBe(2000);
    expect(plan.canvasHeight).toBe(3000);
    expect(plan.bands[0]).toEqual({ scrollY: 0, srcY: 0, destY: 0, height: 2000 });
    // Second band clamps scroll to 500, so srcY = (1000-500)*2 = 1000, height covers the remainder.
    expect(plan.bands[1]).toEqual({ scrollY: 500, srcY: 1000, destY: 2000, height: 1000 });
  });

  it('bounds a very tall page by maxBands (no unbounded capture)', () => {
    const plan = planStitch(metrics({ scrollHeight: 1_000_000, viewportHeight: 1000 }), {
      maxBands: 3,
      maxHeightCss: 20_000,
    });
    expect(plan.bands).toHaveLength(3);
    expect(plan.canvasHeight).toBe(3000); // 3 bands × 1000 css × dpr 1
  });

  it('the stitched bands compose to a contiguous, gap-free canvas', () => {
    const plan = planStitch(metrics({ scrollHeight: 2300, viewportHeight: 1000 }));
    let cursor = 0;
    for (const band of plan.bands) {
      expect(band.destY).toBe(cursor); // each band starts where the previous ended
      cursor += band.height;
    }
    expect(cursor).toBe(plan.canvasHeight); // fully covered, no gap or overrun
  });
});

describe('pageMetrics', () => {
  it('reports at least one viewport for a short page', () => {
    const m = pageMetrics(document, window);
    expect(m.scrollHeight).toBeGreaterThanOrEqual(m.viewportHeight);
    expect(m.viewportWidth).toBeGreaterThan(0);
    expect(m.devicePixelRatio).toBeGreaterThan(0);
  });
});
