import { pickUnique } from '@/dom/selector';
import type {
  A11yNode,
  A11yResult,
  GetStylesResult,
  PageMetrics,
  QueryResult,
  Rect,
} from '@/shared/messages';

// DOM readers — the content script's read half (query / getStyles / a11ySnapshot / screenshot).
// Pure DOM in, typed result out: no chrome.*, so every branch runs under jsdom and the content
// entrypoint (coverage-excluded) stays a thin dispatcher. The agent reads the page through these
// before it mutates — see src/agent/tools/dom.ts + docs/idea/live-edit.md.

// --- query ----------------------------------------------------------------

/** Every element matching `selector` under `root`. An invalid selector yields `[]` rather than
 *  throwing — a bad selector from the model must not crash the content-script bus. */
export function queryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** The first element matching `selector`, or `null`. The single-target resolver the mutation
 *  tools use to turn an agent-supplied selector into the element to change. */
export function queryOne(root: ParentNode, selector: string): Element | null {
  const [first] = queryAll(root, selector);
  return first ?? null;
}

/** Resolve `selector` to a stable, fragility-scored selector per matched element
 *  (`QueryResult`). Each match is re-derived through {@link pickUnique}, so the agent gets the
 *  resilient selector to mutate + hand off against, not the raw one it typed. */
export function query(root: ParentNode, selector: string): QueryResult {
  return { matches: queryAll(root, selector).map((el) => pickUnique(el, root)) };
}

// --- computed styles ------------------------------------------------------

// The design-relevant computed props: color, type, spacing, layout, border. Reading the whole
// CSSStyleDeclaration would drown the signal and blow the token budget, so getStyles projects to
// this curated subset unless the caller names its own props.
export const RELEVANT_STYLE_PROPS = [
  'color',
  'background-color',
  'background-image',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'display',
  'position',
  'flex-direction',
  'justify-content',
  'align-items',
  'gap',
  'width',
  'height',
  'margin',
  'padding',
  'border-radius',
  'box-shadow',
  'opacity',
] as const;

/** Read `props` off `el`'s computed style, dropping empties. When a prop resolves empty (jsdom,
 *  or a not-yet-cascaded rule) and a `fallback` value was supplied, the fallback stands in — so a
 *  just-applied `setStyle` can still report the value it set. */
export function readComputed(
  el: Element,
  props: readonly string[],
  fallback?: Record<string, string>,
): Record<string, string> {
  const computed = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const prop of props) {
    const value = computed.getPropertyValue(prop).trim();
    if (value) {
      out[prop] = value;
    } else if (fallback) {
      const fb = fallback[prop];
      if (fb) out[prop] = fb;
    }
  }
  return out;
}

/** Computed styles for `el`, projected to `props` (defaults to {@link RELEVANT_STYLE_PROPS}). */
export function getStyles(el: Element, props?: readonly string[]): GetStylesResult {
  return { styles: readComputed(el, props && props.length > 0 ? props : RELEVANT_STYLE_PROPS) };
}

// --- accessibility snapshot ----------------------------------------------

// Implicit ARIA role per tag. Enough to make the tree legible to the agent without pulling in a
// full HTML-AAM mapping; anything unlisted is 'generic' (or overridden by an explicit role).
const IMPLICIT_ROLE: Record<string, string> = {
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  aside: 'complementary',
  section: 'region',
  article: 'article',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  button: 'button',
  img: 'img',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  form: 'form',
  select: 'combobox',
  textarea: 'textbox',
  table: 'table',
  dialog: 'dialog',
};

const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta', 'head']);
const MAX_A11Y_DEPTH = 12;
const MAX_A11Y_CHILDREN = 60;

function inputRole(el: Element): string {
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  switch (type) {
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'range':
      return 'slider';
    case 'search':
      return 'searchbox';
    case 'button':
    case 'submit':
    case 'reset':
      return 'button';
    default:
      return 'textbox';
  }
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')?.trim();
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
  if (tag === 'input') return inputRole(el);
  return IMPLICIT_ROLE[tag] ?? 'generic';
}

function accessibleName(el: Element): string {
  const label = el.getAttribute('aria-label')?.trim();
  if (label) return label;

  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const doc = el.ownerDocument;
    const names = labelledby
      .split(/\s+/)
      .map((id) => doc?.getElementById(id)?.textContent?.trim() ?? '')
      .filter((text) => text !== '');
    if (names.length > 0) return names.join(' ');
  }

  if (el.tagName.toLowerCase() === 'img') return (el.getAttribute('alt') ?? '').trim();

  const title = el.getAttribute('title')?.trim();
  if (title) return title;

  // A leaf's own text is its accessible name; bounded so one huge leaf can't blow the budget.
  if (el.children.length === 0) return (el.textContent ?? '').trim().slice(0, 120);
  return '';
}

function isSkippable(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toLowerCase())) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  return el.hasAttribute('hidden');
}

function buildA11yNode(el: Element, depth: number): A11yNode {
  const children: A11yNode[] = [];
  if (depth > 0) {
    for (const child of Array.from(el.children)) {
      if (children.length >= MAX_A11Y_CHILDREN) break;
      if (isSkippable(child)) continue;
      children.push(buildA11yNode(child, depth - 1));
    }
  }
  return { role: roleOf(el), name: accessibleName(el), children };
}

/** Role/name accessibility tree rooted at `el` — cheaper for the agent to read than a screenshot.
 *  Bounded in depth and breadth so a deep page can't blow the token budget. */
export function a11ySnapshot(el: Element, maxDepth = MAX_A11Y_DEPTH): A11yResult {
  return { tree: buildA11yNode(el, maxDepth) };
}

// --- screenshot (crop rect only; the SW captures) ------------------------

// Content can't call chrome.tabs.captureVisibleTab, so screenshot is split: content computes the
// crop rect here, the service worker captures + crops (background.ts screenshot handler, slice
// 05/13). This is the content half — the SW turns the rect into PNG bytes for vision.
export interface ScreenshotRect {
  rect: Rect;
  devicePixelRatio: number;
}

/** Whether `rect` sits (even partly) outside the viewport, so `el` must be scrolled into view
 *  before a single-viewport capture — `captureVisibleTab` only sees what's on screen, so a
 *  below-fold or partly-clipped element would otherwise crop to empty. Pure so it's unit-testable
 *  without a real layout (jsdom's `getBoundingClientRect`/`scrollIntoView` are no-ops). */
export function needsScrollIntoView(
  rect: { top: number; left: number; bottom: number; right: number },
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  return (
    rect.top < 0 || rect.left < 0 || rect.bottom > viewportHeight || rect.right > viewportWidth
  );
}

/** Whether scrolling actually improves what a single-viewport capture of `rect` sees. Per axis:
 *  an element that FITS on that axis benefits when it's clipped there; an element LARGER than the
 *  viewport on that axis benefits only when NONE of it is visible — centering it otherwise just
 *  swaps the currently visible band (the top/left, usually the header/title) for a middle band at
 *  the same capture size, plus a pointless scroll/restore cycle. */
export function scrollImprovesCapture(
  rect: { top: number; left: number; bottom: number; right: number },
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  if (!needsScrollIntoView(rect, viewportWidth, viewportHeight)) return false;
  const vertical =
    rect.bottom - rect.top >= viewportHeight
      ? rect.top >= viewportHeight || rect.bottom <= 0
      : rect.top < 0 || rect.bottom > viewportHeight;
  const horizontal =
    rect.right - rect.left >= viewportWidth
      ? rect.left >= viewportWidth || rect.right <= 0
      : rect.left < 0 || rect.right > viewportWidth;
  return vertical || horizontal;
}

/** The overflow containers `scrollIntoView` will also move, nearest-first: per CSSOM View it
 *  scrolls EVERY scrollable ancestor in the flat tree, not just the document scroller. Snapshot
 *  their offsets before scrolling so the caller can restore them after — else a read-only
 *  screenshot strands a nested panel at a new scroll position. Walks the COMPOSED tree
 *  (assignedSlot → parentElement → shadow host) so a slotted element's in-shadow scroll containers
 *  are covered too. Pure + jsdom-friendly (jsdom reports 0 sizes, yielding `[]`). */
export function scrollableAncestors(el: Element): Element[] {
  const up = (node: Element): Element | null => {
    if (node.assignedSlot) return node.assignedSlot;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const out: Element[] = [];
  for (let p = up(el); p; p = up(p)) {
    if (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth) out.push(p);
  }
  return out;
}

/** The crop rect the SW needs to capture `el` (or the whole viewport when omitted). Pure geometry —
 *  a side-effect-free read: the caller (`content.ts`'s `screenshot`) is responsible for first
 *  scrolling an off-screen `el` into view and letting it paint (see `needsScrollIntoView`), so the
 *  target is already positioned when measured here. */
export function screenshotRect(el?: Element | null): ScreenshotRect {
  const devicePixelRatio = window.devicePixelRatio || 1;
  if (!el) {
    return {
      rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio,
    };
  }
  const r = el.getBoundingClientRect();
  return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, devicePixelRatio };
}

// Source sub-rectangle (device px) of a full-viewport capture. `captureVisibleTab` returns the
// viewport at `dpr` scale, so an element's CSS-px `rect` maps to `rect * dpr`, clamped to the
// image bounds.
export interface CropBox {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** The crop box for `rect` (CSS px) within a `imgWidth x imgHeight` device-px capture, scaled by
 *  `dpr`. Returns `null` when the crop is empty or already covers the whole frame — the SW then
 *  keeps the full capture instead of re-encoding it. Pure math so the SW's OffscreenCanvas glue
 *  (background.ts) has no untested branches. */
export function cropBox(
  rect: Rect,
  dpr: number,
  imgWidth: number,
  imgHeight: number,
): CropBox | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(imgWidth - sx, Math.round(rect.width * dpr));
  const sh = Math.min(imgHeight - sy, Math.round(rect.height * dpr));
  if (sw <= 0 || sh <= 0) return null;
  if (sx === 0 && sy === 0 && sw >= imgWidth && sh >= imgHeight) return null; // whole frame
  return { sx, sy, sw, sh };
}

// --- full-page capture (scroll-stitch geometry) --------------------------

/** The page's scroll + viewport geometry — the content input to the SW's full-page scroll-stitch.
 *  `scroll{Width,Height}` are the max of the documentElement/body scroll size and the viewport, so a
 *  short page still reports at least one viewport. */
export function pageMetrics(doc: Document = document, win: Window = window): PageMetrics {
  const el = doc.documentElement;
  const body = doc.body;
  const scrollWidth = Math.max(el?.scrollWidth ?? 0, body?.scrollWidth ?? 0, win.innerWidth);
  const scrollHeight = Math.max(el?.scrollHeight ?? 0, body?.scrollHeight ?? 0, win.innerHeight);
  return {
    scrollWidth,
    scrollHeight,
    viewportWidth: win.innerWidth,
    viewportHeight: win.innerHeight,
    devicePixelRatio: win.devicePixelRatio || 1,
    scrollX: win.scrollX,
    scrollY: win.scrollY,
  };
}

// One band of a full-page capture: scroll the viewport to `scrollY` (CSS px), grab it, then copy a
// `height`-tall device-px slice from `srcY` in the grab to `destY` on the stitched canvas. The last
// band clamps its scroll to the page bottom, so `srcY > 0` there (its top rows overlap the prior
// band and are skipped) — this is how the stitch avoids a double-exposed seam.
export interface StitchBand {
  scrollY: number;
  srcY: number;
  destY: number;
  height: number;
}

export interface StitchPlan {
  /** Device-px canvas the bands compose onto. */
  canvasWidth: number;
  canvasHeight: number;
  bands: StitchBand[];
}

// Bounds keep the capture cheap: a tall page yields many viewport grabs (each a `captureVisibleTab`
// + a vision-token cost downstream), so cap both the band count and the total stitched height.
export interface StitchLimits {
  maxBands: number;
  maxHeightCss: number;
}
export const DEFAULT_STITCH_LIMITS: StitchLimits = { maxBands: 12, maxHeightCss: 20_000 };

/** Plan the scroll bands + device-px canvas for a full-page capture from the page's {@link
 *  PageMetrics}. Pure math (the SW's OffscreenCanvas glue just runs the returned rects), so the
 *  seam/overlap handling is unit-testable with no chrome. */
export function planStitch(
  m: PageMetrics,
  limits: StitchLimits = DEFAULT_STITCH_LIMITS,
): StitchPlan {
  const dpr = m.devicePixelRatio > 0 ? m.devicePixelRatio : 1;
  const vh = Math.max(1, m.viewportHeight);
  const canvasWidth = Math.max(1, Math.round(m.viewportWidth * dpr));
  // Cover the shorter of: the real page, the absolute cap, and what `maxBands` viewports can reach.
  const coveredCss = Math.min(m.scrollHeight, limits.maxHeightCss, vh * limits.maxBands);
  const canvasHeight = Math.max(1, Math.round(coveredCss * dpr));
  const maxScroll = Math.max(0, m.scrollHeight - vh);
  const bands: StitchBand[] = [];
  for (let top = 0; top < coveredCss; top += vh) {
    const bottom = Math.min(top + vh, coveredCss);
    const scrollY = Math.min(top, maxScroll); // last band clamps to the page bottom (overlaps prior)
    const destY = Math.round(top * dpr);
    const srcY = Math.round((top - scrollY) * dpr);
    const height = Math.min(Math.round((bottom - top) * dpr), canvasHeight - destY);
    if (height <= 0) break;
    bands.push({ scrollY, srcY, destY, height });
  }
  return { canvasWidth, canvasHeight, bands };
}
