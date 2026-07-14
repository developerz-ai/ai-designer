import { queryAll } from '@/dom/read';
import { pickUnique } from '@/dom/selector';
import type { StableSelector } from '@/shared/changeset';

// Responsive / mobile problem scanner (plan slice 16). Runs in the content world AT a given viewport
// width (a breakpoint) and reports real mobile bugs: horizontal overflow, sub-44px tap targets,
// illegibly small text, clipped/truncated content, media that won't scale down, a nav that doesn't
// collapse, and `100vh` / fixed-overlap viewport-unit hazards. Feeds debug mode + the report.
//
// Pure DOM in, typed findings out — no chrome.*, so every branch runs under jsdom. jsdom has no layout
// engine (every real rect is 0×0), so all geometry comes through an injected `ResponsiveProbe`; tests
// supply a fake, `domResponsiveProbe` reads the live DOM. This mirrors `scanLayout`'s `LayoutProbe`
// (src/dom/diagnostics-collector.ts) and complements it: that collector watches for general layout
// signals, this one answers "does the page hold up on a phone at width W?". Read-only, deterministic,
// and bounded (per-pass element caps + a total-findings cap) so a hostile page can't flood the budget.

// --- types ----------------------------------------------------------------

export type ResponsiveCategory =
  | 'overflow' // horizontal overflow / unintended sideways scroll
  | 'tap-target' // interactive target below the min touch size, or overlapping another
  | 'text-legibility' // rendered text below a legible floor
  | 'clip' // content cut off / truncated by an overflow-hidden box
  | 'media-scaling' // image/media wider than the viewport (not scaling down)
  | 'nav' // navigation that doesn't collapse to a menu toggle at mobile width
  | 'viewport-unit'; // `100vh` mobile-chrome bug or fixed/sticky elements overlapping

export type ResponsiveSeverity = 'serious' | 'moderate' | 'minor';

export interface ResponsiveFinding {
  readonly category: ResponsiveCategory;
  readonly severity: ResponsiveSeverity;
  /** Measurement-grounded, human-readable explanation, clipped to {@link DETAIL_MAX}. */
  readonly detail: string;
  /** Stable selector for the offending element; page-level findings anchor on `<html>`. */
  readonly selector: StableSelector;
}

export interface ResponsiveScanResult {
  /** CSS-px viewport width the scan measured at — the breakpoint these findings belong to. */
  readonly viewportWidth: number;
  readonly findings: ResponsiveFinding[];
}

/** An element's box in CSS px relative to the viewport (a subset of `DOMRect`). */
export interface Box {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Geometry + computed values the scans need. Injected because jsdom has no layout engine; the default
 *  {@link domResponsiveProbe} reads the live content-world DOM. */
export interface ResponsiveProbe {
  viewportWidth(): number;
  viewportHeight(): number;
  rect(el: Element): Box;
  /** Full content width vs the padding box — content overflows when `scrollWidth > clientWidth`. */
  scrollWidth(el: Element): number;
  clientWidth(el: Element): number;
  scrollHeight(el: Element): number;
  clientHeight(el: Element): number;
  /** A resolved computed-style value (already px for lengths the engine resolves). */
  computed(el: Element, prop: string): string;
  /** Intrinsic media width (`<img>.naturalWidth`), 0 when unknown / not an image. */
  intrinsicWidth(el: Element): number;
}

export function domResponsiveProbe(win: Window): ResponsiveProbe {
  return {
    viewportWidth: () => win.innerWidth,
    viewportHeight: () => win.innerHeight,
    rect: (el) => {
      const r = el.getBoundingClientRect();
      return {
        width: r.width,
        height: r.height,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      };
    },
    scrollWidth: (el) => (el as HTMLElement).scrollWidth,
    clientWidth: (el) => (el as HTMLElement).clientWidth,
    scrollHeight: (el) => (el as HTMLElement).scrollHeight,
    clientHeight: (el) => (el as HTMLElement).clientHeight,
    computed: (el, prop) => win.getComputedStyle(el).getPropertyValue(prop),
    intrinsicWidth: (el) => (el as HTMLImageElement).naturalWidth || 0,
  };
}

export interface ResponsiveScanOptions {
  /** Subtree to scan; defaults to the whole document. */
  root?: ParentNode;
  /** Geometry source; defaults to {@link domResponsiveProbe} over `win`. */
  probe?: ResponsiveProbe;
  /** Minimum comfortable touch target, px (default {@link MIN_TAP_PX}). */
  minTapPx?: number;
  /** Legible font-size floor, px (default {@link MIN_FONT_PX}). */
  minFontPx?: number;
  /** Only run mobile-only heuristics (nav collapse) at/below this width (default {@link MOBILE_MAX}). */
  mobileMaxWidth?: number;
}

// --- bounds + thresholds --------------------------------------------------

const MAX_FINDINGS = 60; // total scan output cap so one broken page can't flood the report
const MAX_ELEMENTS = 4000; // per-pass element-walk cap on a huge DOM
const MAX_NAVS = 8;
const MAX_FIXED = 40; // fixed/sticky elements tracked for the overlap pass
const DETAIL_MAX = 240;

const OVERFLOW_FUZZ = 2; // px of sub-pixel slack before calling geometry a real overflow
const MIN_TAP_PX = 44; // WCAG 2.5.5 / Apple HIG comfortable touch target
const MIN_FONT_PX = 12; // below this, body text is hard to read on a phone
const MOBILE_MAX = 768; // px viewport at/below which mobile-only checks apply
const NAV_LINK_THRESHOLD = 4; // this many visible top-level links with no toggle looks uncollapsed
const OVERLAP_MIN_PX = 4; // ignore hairline touches when calling two boxes "overlapping"

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[contenteditable="true"]',
  '[onclick]',
].join(', ');

const MEDIA_SELECTOR = 'img, video, iframe, canvas, svg';

// A hamburger / menu toggle: an explicit control or a class/aria hint that a collapsed menu exists.
const NAV_TOGGLE_SELECTOR = [
  'button',
  '[role="button"]',
  '[aria-expanded]',
  '[aria-controls]',
  '[class*="hamburger" i]',
  '[class*="burger" i]',
  '[class*="menu-toggle" i]',
  '[class*="nav-toggle" i]',
  '[class*="menu-btn" i]',
  '[aria-label*="menu" i]',
].join(', ');

// Inline height/min-height/max-height declared in `vh` units (e.g. `min-height: 100vh`).
const INLINE_VH = /(?:^|;)\s*(min-height|max-height|height)\s*:\s*([^;]*?\d[\d.]*vh)/i;

// --- public entry ---------------------------------------------------------

/**
 * Scan `doc` for responsive problems at the current viewport (as reported by the probe). Runs every
 * sub-scan, sorts most-severe-first, and caps the total. Call it once per breakpoint after resizing.
 */
export function scanResponsive(
  doc: Document,
  win: Window,
  opts: ResponsiveScanOptions = {},
): ResponsiveScanResult {
  const probe = opts.probe ?? domResponsiveProbe(win);
  const findings = [
    ...scanOverflow(doc, win, opts),
    ...scanMediaScaling(doc, win, opts),
    ...scanTapTargets(doc, win, opts),
    ...scanTextLegibility(doc, win, opts),
    ...scanClipping(doc, win, opts),
    ...scanNav(doc, win, opts),
    ...scanViewportUnits(doc, win, opts),
  ]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, MAX_FINDINGS);
  return { viewportWidth: probe.viewportWidth(), findings };
}

// --- overflow -------------------------------------------------------------

/** Horizontal overflow: the page scrolls sideways (`scrollWidth > clientWidth`) and the individual
 *  elements rendered wider than the viewport that force it. */
export function scanOverflow(
  doc: Document,
  win: Window,
  opts: ResponsiveScanOptions = {},
): ResponsiveFinding[] {
  const { root, probe, vw } = resolve(doc, win, opts);
  const { out, add } = collector(doc);

  const de = doc.documentElement;
  if (de) {
    const sw = probe.scrollWidth(de);
    const cw = probe.clientWidth(de);
    if (cw > 0 && sw > cw + OVERFLOW_FUZZ) {
      add(
        'overflow',
        'serious',
        `The page scrolls sideways: content is ${round(sw)}px wide in a ${round(cw)}px viewport.`,
        de,
      );
    }
  }

  for (const el of capped(queryAll(root, '*'))) {
    if (out.length >= MAX_FINDINGS) break;
    if (el === de || el === doc.body || !isVisible(el, probe)) continue;
    const w = probe.rect(el).width;
    if (w > vw + OVERFLOW_FUZZ) {
      add(
        'overflow',
        'serious',
        `<${tag(el)}> is ${round(w)}px wide — wider than the ${vw}px viewport, forcing horizontal scroll.`,
        el,
      );
    }
  }
  return out;
}

// --- media scaling --------------------------------------------------------

/** Images/media that don't scale down: rendered wider than the viewport, or intrinsically larger than
 *  the viewport with no `max-width` to constrain them. */
export function scanMediaScaling(
  doc: Document,
  win: Window,
  opts: ResponsiveScanOptions = {},
): ResponsiveFinding[] {
  const { root, probe, vw } = resolve(doc, win, opts);
  const { out, add } = collector(doc);

  for (const el of capped(queryAll(root, MEDIA_SELECTOR))) {
    if (out.length >= MAX_FINDINGS) break;
    if (!isVisible(el, probe)) continue;
    const w = probe.rect(el).width;
    if (w > vw + OVERFLOW_FUZZ) {
      add(
        'media-scaling',
        'serious',
        `<${tag(el)}> renders ${round(w)}px wide in a ${vw}px viewport — it isn't scaling down.`,
        el,
      );
      continue;
    }
    const intrinsic = probe.intrinsicWidth(el);
    if (intrinsic > vw && probe.computed(el, 'max-width') === 'none') {
      add(
        'media-scaling',
        'moderate',
        `<${tag(el)}> is intrinsically ${round(intrinsic)}px wide with no max-width — it can overflow a ${vw}px viewport.`,
        el,
      );
    }
  }
  return out;
}

// --- tap targets ----------------------------------------------------------

/** Interactive elements below the comfortable touch size, and pairs of leaf controls that overlap. */
export function scanTapTargets(
  doc: Document,
  win: Window,
  opts: ResponsiveScanOptions = {},
): ResponsiveFinding[] {
  const { root, probe } = resolve(doc, win, opts);
  const minTap = opts.minTapPx ?? MIN_TAP_PX;
  const { out, add } = collector(doc);

  const leaves: { el: Element; box: Box }[] = [];
  for (const el of capped(queryAll(root, INTERACTIVE_SELECTOR))) {
    if (out.length >= MAX_FINDINGS) break;
    if (!isVisible(el, probe)) continue;
    const box = probe.rect(el);
    // Skip wrappers that contain another control — measure the actual leaf targets.
    if (queryAll(el, INTERACTIVE_SELECTOR).length > 0) continue;
    if (leaves.length < MAX_ELEMENTS) leaves.push({ el, box });
    if (box.width < minTap || box.height < minTap) {
      add(
        'tap-target',
        'moderate',
        `<${tag(el)}> is ${round(box.width)}×${round(box.height)}px — below the ${minTap}×${minTap}px touch target.`,
        el,
      );
    }
  }

  scanOverlaps(leaves, add);
  return out;
}

// Flag distinct leaf controls whose boxes meaningfully overlap (fat-finger hazard). Bounded pairwise;
// each element is reported at most once.
function scanOverlaps(
  leaves: { el: Element; box: Box }[],
  add: (c: ResponsiveCategory, s: ResponsiveSeverity, d: string, el: Element) => void,
): void {
  const flagged = new Set<Element>();
  for (let i = 0; i < leaves.length; i++) {
    const a = leaves[i];
    if (!a || flagged.has(a.el)) continue;
    for (let j = i + 1; j < leaves.length; j++) {
      const b = leaves[j];
      if (!b || flagged.has(b.el)) continue;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (!overlaps(a.box, b.box)) continue;
      add(
        'tap-target',
        'moderate',
        `<${tag(a.el)}> and <${tag(b.el)}> overlap — adjacent touch targets are hard to tap accurately.`,
        a.el,
      );
      flagged.add(a.el);
      flagged.add(b.el);
      break;
    }
  }
}

// --- text legibility ------------------------------------------------------

/** Text-bearing elements whose computed font-size is below the legible floor. */
export function scanTextLegibility(
  doc: Document,
  win: Window,
  opts: ResponsiveScanOptions = {},
): ResponsiveFinding[] {
  const { root, probe } = resolve(doc, win, opts);
  const minFont = opts.minFontPx ?? MIN_FONT_PX;
  const { out, add } = collector(doc);

  for (const el of capped(
    queryAll(root, 'p, span, a, li, td, th, label, button, h1, h2, h3, h4, h5, h6'),
  )) {
    if (out.length >= MAX_FINDINGS) break;
    if (!hasDirectText(el) || !isVisible(el, probe)) continue;
    const px = Number.parseFloat(probe.computed(el, 'font-size'));
    if (Number.isFinite(px) && px > 0 && px < minFont) {
      add(
        'text-legibility',
        px < minFont - 2 ? 'moderate' : 'minor',
        `<${tag(el)}> text is ${round(px)}px — below the ${minFont}px legible floor for mobile.`,
        el,
      );
    }
  }
  return out;
}

// --- clipping -------------------------------------------------------------

/** Content cut off by an `overflow: hidden` / `clip` box (its scroll size exceeds its client box), or
 *  single-line text truncated with an ellipsis. Scroll/auto boxes are excluded — those are reachable. */
export function scanClipping(
  doc: Document,
  win: Window,
  opts: ResponsiveScanOptions = {},
): ResponsiveFinding[] {
  const { root, probe } = resolve(doc, win, opts);
  const { out, add } = collector(doc);

  for (const el of capped(queryAll(root, '*'))) {
    if (out.length >= MAX_FINDINGS) break;
    if (!isVisible(el, probe)) continue;
    const overflowX = probe.computed(el, 'overflow-x');
    const overflowY = probe.computed(el, 'overflow-y');
    const clipsX = isClipping(overflowX);
    const clipsY = isClipping(overflowY);
    if (!clipsX && !clipsY) continue;

    const cutX = clipsX && probe.scrollWidth(el) > probe.clientWidth(el) + OVERFLOW_FUZZ;
    const cutY = clipsY && probe.scrollHeight(el) > probe.clientHeight(el) + OVERFLOW_FUZZ;
    if (!cutX && !cutY) continue;

    if (cutX && probe.computed(el, 'text-overflow') === 'ellipsis') {
      add(
        'clip',
        'minor',
        `<${tag(el)}> text is truncated with an ellipsis (${round(probe.scrollWidth(el))}px of content in ${round(probe.clientWidth(el))}px).`,
        el,
      );
    } else {
      const axis = cutX ? 'horizontally' : 'vertically';
      add('clip', 'moderate', `<${tag(el)}> clips its content ${axis} (overflow hidden).`, el);
    }
  }
  return out;
}

// --- navigation -----------------------------------------------------------

/** At mobile width, a nav landmark showing several links with no menu toggle in reach — a sign it
 *  never collapses to a hamburger. Skipped above `mobileMaxWidth` (desktop navs are meant to be open). */
export function scanNav(
  doc: Document,
  win: Window,
  opts: ResponsiveScanOptions = {},
): ResponsiveFinding[] {
  const { root, probe, vw } = resolve(doc, win, opts);
  const mobileMax = opts.mobileMaxWidth ?? MOBILE_MAX;
  const { out, add } = collector(doc);
  if (vw > mobileMax) return out;

  let seen = 0;
  for (const nav of queryAll(root, 'nav, [role="navigation"]')) {
    if (out.length >= MAX_FINDINGS || seen >= MAX_NAVS) break;
    if (!isVisible(nav, probe)) continue;
    seen++;
    const links = queryAll(nav, 'a[href], [role="link"]').filter((l) => isVisible(l, probe));
    if (links.length < NAV_LINK_THRESHOLD) continue;
    if (hasNavToggle(nav)) continue;
    add(
      'nav',
      'moderate',
      `${links.length} nav links are visible at ${vw}px with no menu toggle — the navigation may not collapse for mobile.`,
      nav,
    );
  }
  return out;
}

// A hamburger/menu control within the nav or its enclosing header.
function hasNavToggle(nav: Element): boolean {
  const scope = nav.closest('header') ?? nav;
  return queryAll(scope, NAV_TOGGLE_SELECTOR).length > 0;
}

// --- viewport units + fixed overlap ---------------------------------------

/** `100vh`-style viewport-unit hazards (mobile browser chrome makes them overflow/clip) and
 *  fixed/sticky elements that overlap on a small screen. */
export function scanViewportUnits(
  doc: Document,
  win: Window,
  opts: ResponsiveScanOptions = {},
): ResponsiveFinding[] {
  const { root, probe } = resolve(doc, win, opts);
  const { out, add } = collector(doc);

  for (const el of capped(queryAll(root, '[style]'))) {
    if (out.length >= MAX_FINDINGS) break;
    const match = INLINE_VH.exec(el.getAttribute('style') ?? '');
    if (match) {
      add(
        'viewport-unit',
        'minor',
        `Inline ${match[1]}: ${match[2]?.trim()} uses vh — 100vh includes mobile browser chrome and can overflow or clip; prefer dvh/svh.`,
        el,
      );
    }
  }

  scanFixedOverlaps(root, probe, add);
  return out;
}

// Collect visible fixed/sticky elements (bounded) and flag overlapping pairs — a common mobile bug
// where a sticky header/footer covers content or another pinned element.
function scanFixedOverlaps(
  root: ParentNode,
  probe: ResponsiveProbe,
  add: (c: ResponsiveCategory, s: ResponsiveSeverity, d: string, el: Element) => void,
): void {
  const pinned: { el: Element; box: Box }[] = [];
  for (const el of capped(queryAll(root, '*'))) {
    if (pinned.length >= MAX_FIXED) break;
    const position = probe.computed(el, 'position');
    if ((position === 'fixed' || position === 'sticky') && isVisible(el, probe)) {
      pinned.push({ el, box: probe.rect(el) });
    }
  }

  const flagged = new Set<Element>();
  for (let i = 0; i < pinned.length; i++) {
    const a = pinned[i];
    if (!a || flagged.has(a.el)) continue;
    for (let j = i + 1; j < pinned.length; j++) {
      const b = pinned[j];
      if (!b || flagged.has(b.el)) continue;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (!overlaps(a.box, b.box)) continue;
      add(
        'viewport-unit',
        'moderate',
        `Fixed/sticky <${tag(a.el)}> and <${tag(b.el)}> overlap — one can obscure the other on a small screen.`,
        a.el,
      );
      flagged.add(a.el);
      flagged.add(b.el);
      break;
    }
  }
}

// --- shared helpers -------------------------------------------------------

const SEVERITY_RANK: Record<ResponsiveSeverity, number> = { serious: 0, moderate: 1, minor: 2 };

interface Resolved {
  root: ParentNode;
  probe: ResponsiveProbe;
  vw: number;
}

function resolve(doc: Document, win: Window, opts: ResponsiveScanOptions): Resolved {
  const probe = opts.probe ?? domResponsiveProbe(win);
  return { root: opts.root ?? doc, probe, vw: probe.viewportWidth() };
}

// A bounded finding sink: each `add` re-derives the stable selector and stops at the total cap.
function collector(doc: Document): {
  out: ResponsiveFinding[];
  add: (c: ResponsiveCategory, s: ResponsiveSeverity, d: string, el: Element) => void;
} {
  const out: ResponsiveFinding[] = [];
  const add = (
    category: ResponsiveCategory,
    severity: ResponsiveSeverity,
    detail: string,
    el: Element,
  ): void => {
    if (out.length >= MAX_FINDINGS) return;
    out.push({
      category,
      severity,
      detail: clip(detail, DETAIL_MAX),
      selector: pickUnique(el, doc),
    });
  };
  return { out, add };
}

function capped(els: Element[]): Element[] {
  return els.length > MAX_ELEMENTS ? els.slice(0, MAX_ELEMENTS) : els;
}

function tag(el: Element): string {
  return el.tagName.toLowerCase();
}

function isClipping(overflow: string): boolean {
  return overflow === 'hidden' || overflow === 'clip';
}

function isVisible(el: Element, probe: ResponsiveProbe): boolean {
  if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return false;
  if (probe.computed(el, 'display') === 'none') return false;
  const visibility = probe.computed(el, 'visibility');
  if (visibility === 'hidden' || visibility === 'collapse') return false;
  const box = probe.rect(el);
  return box.width > 0 && box.height > 0;
}

// Two boxes overlap when they intersect by more than a hairline on both axes.
function overlaps(a: Box, b: Box): boolean {
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return x > OVERLAP_MIN_PX && y > OVERLAP_MIN_PX;
}

function hasDirectText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 && (node.textContent ?? '').trim() !== '') return true;
  }
  return false;
}

function round(n: number): number {
  return Math.round(n);
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
