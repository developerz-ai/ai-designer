// Derived layout — the half of "what does this element actually do on the page" that neither the
// DOM nor `getComputedStyle` answers. Computed style says `overflow: hidden`; it does not say WHICH
// ancestor is clipping this element. It says `z-index: 10`; it does not say that an ancestor's
// `transform` made that 10 meaningless. It says `display: block`; it does not say the element is
// behind a cookie banner.
//
// These are the questions a design agent asks constantly and currently answers by guessing from a
// screenshot. Each is a bounded, parameterized read — no page JS is executed, nothing is mutated.
// Pure DOM + injected window/document, so every branch runs under jsdom.

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BoxInfo {
  readonly rect: Rect;
  /** Content-box size, i.e. the rect minus padding and border. */
  readonly content: { readonly width: number; readonly height: number };
  readonly margin: Edges;
  readonly padding: Edges;
  readonly border: Edges;
  /** Fraction of the element's own area currently inside the viewport, 0..1. */
  readonly visibleRatio: number;
  readonly inViewport: boolean;
}

export interface Edges {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

function px(style: CSSStyleDeclaration, prop: string): number {
  const n = Number.parseFloat(style.getPropertyValue(prop));
  return Number.isFinite(n) ? n : 0;
}

function edges(style: CSSStyleDeclaration, prefix: string, suffix = ''): Edges {
  return {
    top: px(style, `${prefix}-top${suffix}`),
    right: px(style, `${prefix}-right${suffix}`),
    bottom: px(style, `${prefix}-bottom${suffix}`),
    left: px(style, `${prefix}-left${suffix}`),
  };
}

function toRect(r: DOMRect): Rect {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Geometry + box model + how much of the element the user can actually see right now. */
export function boxOf(el: Element, win: Window): BoxInfo {
  const rect = el.getBoundingClientRect();
  const style = win.getComputedStyle(el);
  const padding = edges(style, 'padding');
  const border = edges(style, 'border', '-width');
  const vw = win.innerWidth || 0;
  const vh = win.innerHeight || 0;
  const visibleW = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
  const visibleH = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
  const area = rect.width * rect.height;
  const visibleRatio = area > 0 ? (visibleW * visibleH) / area : 0;
  return {
    rect: toRect(rect),
    content: {
      width: Math.max(0, rect.width - padding.left - padding.right - border.left - border.right),
      height: Math.max(0, rect.height - padding.top - padding.bottom - border.top - border.bottom),
    },
    margin: edges(style, 'margin'),
    padding,
    border,
    visibleRatio,
    inViewport: visibleRatio > 0,
  };
}

export interface OverflowInfo {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly overflowsX: boolean;
  readonly overflowsY: boolean;
  /** The nearest ancestor whose `overflow` cuts this element off, with the reason — the answer to
   *  "why is my dropdown truncated". `null` when nothing clips it. */
  readonly clippedBy: { readonly selector: string; readonly overflow: string } | null;
}

const CLIPPING = new Set(['hidden', 'clip', 'scroll', 'auto']);

// The effective `overflow-x` / `overflow-y`. A browser expands the `overflow` shorthand into both
// longhands, but a headless DOM leaves them at `visible` while the shorthand reads `hidden` — and
// missing the clip is the one failure mode these two ops exist to prevent. So: trust the longhand
// when it is itself non-initial, otherwise fall back to the shorthand.
function overflowAxis(style: CSSStyleDeclaration, axis: 'X' | 'Y'): string {
  const longhand = (axis === 'X' ? style.overflowX : style.overflowY) || '';
  if (CLIPPING.has(longhand)) return longhand;
  const shorthand = style.overflow || '';
  return CLIPPING.has(shorthand) ? shorthand : longhand || shorthand;
}

/**
 * Whether the element's own content overflows it, and which ancestor (if any) clips the element
 * itself. Two different bugs that look identical in a screenshot: content spilling out of its box,
 * and a box being cut off by something above it.
 *
 * `describe` turns an ancestor into a name for the report; the caller injects it so this module
 * does not depend on the selector engine.
 */
export function overflowOf(
  el: Element,
  win: Window,
  describe: (ancestor: Element) => string,
): OverflowInfo {
  const rect = el.getBoundingClientRect();
  let clippedBy: OverflowInfo['clippedBy'] = null;
  let cur = el.parentElement;
  while (cur && !clippedBy) {
    const style = win.getComputedStyle(cur);
    const x = overflowAxis(style, 'X');
    const y = overflowAxis(style, 'Y');
    const overflow = `${x} ${y}`.trim();
    if (CLIPPING.has(x) || CLIPPING.has(y)) {
      const box = cur.getBoundingClientRect();
      const cut =
        rect.right > box.right + 1 ||
        rect.left < box.left - 1 ||
        rect.bottom > box.bottom + 1 ||
        rect.top < box.top - 1;
      if (cut) clippedBy = { selector: describe(cur), overflow };
    }
    cur = cur.parentElement;
  }
  return {
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowsX: el.scrollWidth > el.clientWidth + 1,
    overflowsY: el.scrollHeight > el.clientHeight + 1,
    clippedBy,
  };
}

export interface ScrollContainerInfo {
  /** `null` when the element scrolls with the document itself. */
  readonly selector: string | null;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly clientHeight: number;
  readonly clientWidth: number;
}

/**
 * The nearest ancestor that actually scrolls this element, and where it currently sits. "Scroll the
 * page" silently does nothing inside a virtualized list or a modal body; this is how an agent finds
 * out which box to scroll instead.
 */
export function scrollContainerOf(
  el: Element,
  win: Window,
  describe: (ancestor: Element) => string,
): ScrollContainerInfo {
  let cur = el.parentElement;
  while (cur) {
    const style = win.getComputedStyle(cur);
    const x = overflowAxis(style, 'X');
    const y = overflowAxis(style, 'Y');
    const scrollableY = (y === 'auto' || y === 'scroll') && cur.scrollHeight > cur.clientHeight + 1;
    const scrollableX = (x === 'auto' || x === 'scroll') && cur.scrollWidth > cur.clientWidth + 1;
    if (scrollableY || scrollableX) {
      return {
        selector: describe(cur),
        scrollTop: cur.scrollTop,
        scrollLeft: cur.scrollLeft,
        scrollHeight: cur.scrollHeight,
        scrollWidth: cur.scrollWidth,
        clientHeight: cur.clientHeight,
        clientWidth: cur.clientWidth,
      };
    }
    cur = cur.parentElement;
  }
  const root = el.ownerDocument.scrollingElement ?? el.ownerDocument.documentElement;
  return {
    selector: null,
    scrollTop: root.scrollTop,
    scrollLeft: root.scrollLeft,
    scrollHeight: root.scrollHeight,
    scrollWidth: root.scrollWidth,
    clientHeight: root.clientHeight,
    clientWidth: root.clientWidth,
  };
}

export interface StackingInfo {
  readonly zIndex: string;
  readonly position: string;
  /** Whether the element forms its own stacking context, and why. */
  readonly formsContext: readonly string[];
  /** The nearest ancestor that forms a stacking context, and why — the reason a large z-index can
   *  still lose to a small one. `null` when the root is the only context above it. */
  readonly containedBy: { readonly selector: string; readonly reasons: readonly string[] } | null;
}

/** Every property on `el` that makes it a stacking context. Empty = it does not form one. */
function stackingReasons(style: CSSStyleDeclaration): string[] {
  const reasons: string[] = [];
  const position = style.position;
  if (position === 'fixed' || position === 'sticky') {
    reasons.push(`position: ${position}`);
  }
  if (position !== 'static' && position !== '' && style.zIndex !== 'auto' && style.zIndex !== '') {
    reasons.push(`position: ${position} with z-index: ${style.zIndex}`);
  }
  const opacity = Number.parseFloat(style.opacity);
  if (Number.isFinite(opacity) && opacity < 1) reasons.push(`opacity: ${style.opacity}`);
  for (const prop of [
    'transform',
    'filter',
    'perspective',
    'clip-path',
    'mask',
    'backdrop-filter',
  ]) {
    const value = style.getPropertyValue(prop);
    if (value && value !== 'none') reasons.push(`${prop}: ${value}`);
  }
  if (style.isolation === 'isolate') reasons.push('isolation: isolate');
  if (style.mixBlendMode && style.mixBlendMode !== 'normal') {
    reasons.push(`mix-blend-mode: ${style.mixBlendMode}`);
  }
  const willChange = style.willChange;
  if (willChange && willChange !== 'auto') reasons.push(`will-change: ${willChange}`);
  const contain = style.contain;
  if (contain && /\b(paint|layout|strict|content)\b/.test(contain)) {
    reasons.push(`contain: ${contain}`);
  }
  return reasons;
}

/** Why an element paints above or below its neighbours. `z-index` alone is famously not the
 *  answer — a `transform` or an `opacity` on an ancestor traps the element in that ancestor's
 *  layer, and no z-index inside can escape it. */
export function stackingOf(
  el: Element,
  win: Window,
  describe: (ancestor: Element) => string,
): StackingInfo {
  const style = win.getComputedStyle(el);
  let containedBy: StackingInfo['containedBy'] = null;
  let cur = el.parentElement;
  while (cur && !containedBy) {
    const reasons = stackingReasons(win.getComputedStyle(cur));
    if (reasons.length > 0) containedBy = { selector: describe(cur), reasons };
    cur = cur.parentElement;
  }
  return {
    zIndex: style.zIndex,
    position: style.position,
    formsContext: stackingReasons(style),
    containedBy,
  };
}

export interface VisibilityInfo {
  readonly visible: boolean;
  /** Every reason the element is not visible, most proximate first. Empty when it is visible. */
  readonly reasons: readonly string[];
  /** What the browser hit-tests at the element's centre, when that is NOT this element or one of
   *  its descendants — the answer to "the click does nothing". */
  readonly occludedBy: string | null;
}

/**
 * EFFECTIVE visibility, walking the ancestor chain rather than reading one element's computed
 * style. `display: block` on the element itself proves nothing when a grandparent is
 * `display: none`, is zero-height, or has a cookie banner painted over it.
 */
export function visibilityOf(
  el: Element,
  win: Window,
  describe: (ancestor: Element) => string,
): VisibilityInfo {
  const reasons: string[] = [];
  let cur: Element | null = el;
  while (cur) {
    const style = win.getComputedStyle(cur);
    const who = cur === el ? 'element' : `ancestor ${describe(cur)}`;
    if (style.display === 'none') reasons.push(`${who}: display: none`);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') {
      reasons.push(`${who}: visibility: ${style.visibility}`);
    }
    if (Number.parseFloat(style.opacity) === 0) reasons.push(`${who}: opacity: 0`);
    if (style.contentVisibility === 'hidden') reasons.push(`${who}: content-visibility: hidden`);
    if (cur instanceof HTMLElement && cur.hidden) reasons.push(`${who}: [hidden]`);
    if (cur.getAttribute('aria-hidden') === 'true') reasons.push(`${who}: aria-hidden="true"`);
    cur = cur.parentElement;
  }

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) reasons.push('element: zero size');

  let occludedBy: string | null = null;
  const doc = el.ownerDocument;
  if (rect.width > 0 && rect.height > 0 && typeof doc.elementFromPoint === 'function') {
    const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      occludedBy = describe(hit);
      reasons.push(`covered by ${occludedBy}`);
    }
  }

  return { visible: reasons.length === 0, reasons, occludedBy };
}
