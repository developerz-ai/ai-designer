import { parseColor, primaryFamily } from '@/dom/design-read';
import { queryAll } from '@/dom/read';

// Design-identity extractor — reduces a live page to a compact, token-like "identity": a
// role-tagged color palette (bg/fg/accent/border), a type scale (families/sizes/weights), and the
// spacing / radius / shadow rhythm. Pure DOM in, typed `Identity` out: no chrome.*, so every branch
// runs under jsdom and the content entrypoint (coverage-excluded) stays a thin dispatcher. Powers
// the `extractIdentity` tool — copy mode reuses the reference's identity, reports render it as
// tokens instead of raw hex (plan slice 14, docs/idea/agent.md). Everything is bounded so a huge
// DOM can't blow the agent's token budget.
//
// Sibling of design-read.ts (which feeds `browse`): identity is richer (accent role + spacing /
// radius / shadow) but reuses design-read's tested color/family parsers rather than re-deriving
// them.

export type IdentityRole = 'bg' | 'fg' | 'accent' | 'border';

export interface IdentityColor {
  /** Normalized lowercase `#rrggbb`. */
  readonly hex: string;
  /** The role this color is used as most across the sampled elements (frequency-ranked). */
  readonly role: IdentityRole;
  /** Sampled element uses (accent is an extra signal, so it does not inflate the count). */
  readonly count: number;
}

export interface TypeScale {
  /** Primary font families, most-used first. */
  readonly families: string[];
  /** Distinct font sizes (px), largest first — the visible type scale. */
  readonly sizes: number[];
  /** Distinct numeric font weights, lightest first (`normal`→400, `bold`→700). */
  readonly weights: number[];
}

export interface Identity {
  readonly palette: IdentityColor[];
  readonly type: TypeScale;
  /** Spacing rhythm (px): the most common padding/margin/gap steps, smallest first. */
  readonly spacing: number[];
  /** Distinct non-zero border radii (px), smallest first. */
  readonly radius: number[];
  /** Distinct drawn `box-shadow` values (whitespace-normalized), most-used first. */
  readonly shadows: string[];
}

export interface IdentityOptions {
  /** Bound the returned palette (defaults to {@link MAX_COLORS}). */
  readonly maxColors?: number;
  /** Cap the element walk on a huge DOM (defaults to {@link MAX_ELEMENTS}). */
  readonly maxElements?: number;
}

const MAX_ELEMENTS = 5000;
const MAX_COLORS = 12;
const MAX_FAMILIES = 4;
const MAX_SIZES = 10;
const MAX_WEIGHTS = 8;
const MAX_SPACING = 8;
const MAX_RADIUS = 6;
const MAX_SHADOWS = 6;
// Spacing above this (px) is layout structure, not the repeated rhythm we want to surface.
const MAX_SPACING_PX = 160;

const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta', 'head']);
const SIDES = ['top', 'right', 'bottom', 'left'] as const;

// Interactive / call-to-action elements whose signature color is the brand accent. Matched once up
// front so the palette walk is a cheap Set membership test. Split so an engine that rejects the
// case-insensitive `[class*=… i]` form still resolves the robust base selectors (queryAll swallows a
// per-selector failure — see read.ts).
const ACCENT_SELECTORS = [
  'a[href], button, [role="button"], input[type="submit"], input[type="button"]',
  '[class*="btn" i]',
  '[class*="cta" i]',
];

// jsdom's computed style returns this placeholder for `font-family` (it doesn't resolve the font
// cascade); treated as "no value" so the extractor falls back to the inline stack.
const UA_FONT_PLACEHOLDER = 'depends on user agent';

/**
 * Extract a compact {@link Identity} from a loaded document. Deterministic and bounded: the walk is
 * capped at {@link MAX_ELEMENTS} visible elements and every returned list is length-limited. Reads
 * computed styles through `win.getComputedStyle`, so it resolves the real cascade in a live page and
 * the inline/default cascade under jsdom.
 */
export function extractIdentity(doc: Document, win: Window, opts: IdentityOptions = {}): Identity {
  const elements = collectVisible(doc, win, opts.maxElements ?? MAX_ELEMENTS);
  const accents = new Set<Element>();
  for (const selector of ACCENT_SELECTORS) {
    for (const el of queryAll(doc, selector)) accents.add(el);
  }
  return {
    palette: palette(elements, accents, win, opts.maxColors ?? MAX_COLORS),
    type: typeScale(elements, win),
    spacing: spacing(elements, win),
    radius: radius(elements, win),
    shadows: shadows(elements, win),
  };
}

// --- element collection ---------------------------------------------------

function collectVisible(doc: Document, win: Window, max: number): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(doc.body?.querySelectorAll('*') ?? [])) {
    if (out.length >= max) break;
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
    if (!isVisible(el, win)) continue;
    out.push(el);
  }
  return out;
}

// Read a computed longhand via `getPropertyValue` (kebab-case), matching read.ts / design-read.ts:
// the camelCase accessors return a UA placeholder under jsdom, whereas `getPropertyValue` resolves
// the cascaded value in both jsdom and a live page.
function cssProp(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
}

// The element's own inline value for `name` — a jsdom fallback for the few props whose computed
// value it leaves empty (font stacks, box-shadow), and the path a just-set inline style reports.
function inlineProp(el: Element, name: string): string {
  return (el as Partial<ElementCSSInlineStyle>).style?.getPropertyValue(name).trim() ?? '';
}

function isVisible(el: Element, win: Window): boolean {
  const style = win.getComputedStyle(el);
  return cssProp(style, 'display') !== 'none' && cssProp(style, 'visibility') !== 'hidden';
}

function hasDirectText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */ && (node.textContent ?? '').trim() !== '') return true;
  }
  return false;
}

function hasBorder(style: CSSStyleDeclaration): boolean {
  const drawn = cssProp(style, 'border-top-style');
  return (
    drawn !== '' && drawn !== 'none' && parseFloat(cssProp(style, 'border-top-width') || '0') > 0
  );
}

// --- palette --------------------------------------------------------------

type RoleCounts = Record<IdentityRole, number>;

function palette(
  elements: Element[],
  accents: Set<Element>,
  win: Window,
  maxColors: number,
): IdentityColor[] {
  const byHex = new Map<string, RoleCounts>();
  const bump = (hex: string | null, role: IdentityRole): void => {
    if (!hex) return;
    const counts = byHex.get(hex) ?? { bg: 0, fg: 0, accent: 0, border: 0 };
    counts[role] += 1;
    byHex.set(hex, counts);
  };

  for (const el of elements) {
    const style = win.getComputedStyle(el);
    const bg = parseColor(cssProp(style, 'background-color'));
    // Text color only counts where the element renders its own ink, so container inheritance
    // doesn't drown the real text color.
    const fg = hasDirectText(el) ? parseColor(cssProp(style, 'color')) : null;
    bump(bg, 'bg');
    bump(fg, 'fg');
    if (hasBorder(style)) bump(parseColor(cssProp(style, 'border-top-color')), 'border');
    // A call-to-action's fill (or its ink when it has no fill) is the brand accent.
    if (accents.has(el)) bump(bg ?? fg, 'accent');
  }

  return [...byHex.entries()]
    .map(([hex, counts]) => ({ hex, role: dominantRole(counts), count: total(counts) }))
    .sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex))
    .slice(0, maxColors);
}

// The role a color is used as most. Ties resolve toward the more intentional role (accent > fg > bg
// > border), so a CTA/link color reads as `accent` rather than a generic surface or ink.
function dominantRole(counts: RoleCounts): IdentityRole {
  let role: IdentityRole = 'bg';
  let max = -1;
  for (const r of ['accent', 'fg', 'bg', 'border'] as const) {
    if (counts[r] > max) {
      max = counts[r];
      role = r;
    }
  }
  return role;
}

// Ranking count = real element usage. `accent` is derived from bg/fg (never a color of its own), so
// including it would double-count; it steers the role, not the rank.
function total(counts: RoleCounts): number {
  return counts.bg + counts.fg + counts.border;
}

// --- type scale -----------------------------------------------------------

function typeScale(elements: Element[], win: Window): TypeScale {
  const families = new Map<string, number>();
  const sizes = new Set<number>();
  const weights = new Set<number>();

  for (const el of elements) {
    if (!hasDirectText(el)) continue;
    const style = win.getComputedStyle(el);
    const family = primaryFamily(fontFamilyOf(el, style));
    if (family) families.set(family, (families.get(family) ?? 0) + 1);
    const size = Math.round(parseFloat(cssProp(style, 'font-size') || ''));
    if (Number.isFinite(size) && size > 0) sizes.add(size);
    const weight = fontWeight(el, style);
    if (weight !== null) weights.add(weight);
  }

  return {
    families: [...families.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_FAMILIES)
      .map(([name]) => name),
    sizes: [...sizes].sort((a, b) => b - a).slice(0, MAX_SIZES),
    weights: [...weights].sort((a, b) => a - b).slice(0, MAX_WEIGHTS),
  };
}

/** The font-family stack for `el`: the computed value in a live page, falling back to the inline
 *  value when the computed stack is unavailable (jsdom). */
function fontFamilyOf(el: Element, style: CSSStyleDeclaration): string {
  const computed = cssProp(style, 'font-family');
  if (computed && computed !== UA_FONT_PLACEHOLDER) return computed;
  return inlineProp(el, 'font-family');
}

function fontWeight(el: Element, style: CSSStyleDeclaration): number | null {
  return normalizeWeight(cssProp(style, 'font-weight') || inlineProp(el, 'font-weight'));
}

function normalizeWeight(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (value === '') return null;
  if (value === 'normal') return 400;
  if (value === 'bold') return 700;
  // `bolder` / `lighter` are relative to the inherited weight — unresolvable here, so skip.
  const n = Math.round(parseFloat(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// --- spacing rhythm -------------------------------------------------------

function spacing(elements: Element[], win: Window): number[] {
  const freq = new Map<number, number>();
  const add = (px: number | null): void => {
    if (px !== null && px > 0 && px <= MAX_SPACING_PX) freq.set(px, (freq.get(px) ?? 0) + 1);
  };

  for (const el of elements) {
    const style = win.getComputedStyle(el);
    for (const box of ['padding', 'margin'] as const) boxSpacing(el, style, box).forEach(add);
    gapSpacing(style).forEach(add);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]) // most common first
    .slice(0, MAX_SPACING)
    .map(([px]) => px)
    .sort((a, b) => a - b); // then present as an ascending scale
}

// Per-side `padding`/`margin` values, falling back to the shorthand when the longhands are empty
// (so detection survives whichever way the engine expands the cascade).
function boxSpacing(el: Element, style: CSSStyleDeclaration, box: 'padding' | 'margin'): number[] {
  const sides = SIDES.map((side) => pxValue(cssProp(style, `${box}-${side}`)));
  if (sides.some((v) => v !== null)) return sides.filter((v): v is number => v !== null);
  const short = pxValue(firstToken(cssProp(style, box) || inlineProp(el, box)));
  return short !== null ? [short] : [];
}

function gapSpacing(style: CSSStyleDeclaration): number[] {
  const rowGap = pxValue(cssProp(style, 'row-gap'));
  const colGap = pxValue(cssProp(style, 'column-gap'));
  if (rowGap !== null || colGap !== null) {
    return [rowGap, colGap].filter((v): v is number => v !== null);
  }
  const gap = pxValue(firstToken(cssProp(style, 'gap')));
  return gap !== null ? [gap] : [];
}

// --- radius ---------------------------------------------------------------

// The shorthand *and* the four corners: engines disagree on which they populate (jsdom fills the
// shorthand but leaves the corners at '0'; a real browser does the reverse), so sample every px>0
// across all of them, deduped. `firstToken` takes the top-left of a per-corner shorthand.
const RADIUS_PROPS = [
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
] as const;

function radius(elements: Element[], win: Window): number[] {
  const set = new Set<number>();
  for (const el of elements) {
    const style = win.getComputedStyle(el);
    for (const prop of RADIUS_PROPS) {
      const px = pxValue(firstToken(cssProp(style, prop)));
      if (px !== null && px > 0) set.add(px);
    }
    const inlinePx = pxValue(firstToken(inlineProp(el, 'border-radius')));
    if (inlinePx !== null && inlinePx > 0) set.add(inlinePx);
  }
  return [...set].sort((a, b) => a - b).slice(0, MAX_RADIUS);
}

// --- shadows --------------------------------------------------------------

function shadows(elements: Element[], win: Window): string[] {
  const freq = new Map<string, number>();
  for (const el of elements) {
    const raw = cssProp(win.getComputedStyle(el), 'box-shadow') || inlineProp(el, 'box-shadow');
    const shadow = normalizeShadow(raw);
    if (shadow) freq.set(shadow, (freq.get(shadow) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SHADOWS)
    .map(([shadow]) => shadow);
}

function normalizeShadow(raw: string): string | null {
  const value = raw.trim();
  if (!value || value === 'none') return null;
  return value.replace(/\s+/g, ' ');
}

// --- shared parsing -------------------------------------------------------

/** A `px` CSS length as a rounded integer, or `null` for any other unit / empty / unparseable. */
function pxValue(value: string): number | null {
  if (!value.endsWith('px')) return null;
  const n = Math.round(parseFloat(value));
  return Number.isFinite(n) ? n : null;
}

/** First whitespace/slash-separated token of a value (e.g. the top-left of a `border-radius`
 *  shorthand, or the first length of a `gap`). */
function firstToken(value: string): string {
  return value.trim().split(/[\s/]+/)[0] ?? '';
}
