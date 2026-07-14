import { queryAll } from '@/dom/read';
import type {
  DesignComponent,
  DesignRead,
  DesignRegion,
  PaletteColor,
  Typography,
} from '@/shared/messages';

// Design-read extractor — reduces a whole page to a compact, token-bounded "design identity"
// (palette / typography / layout regions / key components). Pure DOM in, typed `DesignRead` out:
// no chrome.*, so every branch runs under jsdom and the content entrypoint (coverage-excluded)
// stays a thin dispatcher. Consumed by `browse(url)` (src/agent/tools/browse.ts) after the SW
// opens a reference site in a background tab — the reference's identity in text, cheaper than a
// screenshot and reusable (docs/idea/agent.md). Everything here is bounded so a huge page can't
// blow the agent's token budget.

const MAX_ELEMENTS = 5000; // cap the palette/typography walk on a huge DOM
const MAX_COLORS = 12;
const MAX_FAMILIES = 4;
const MAX_SCALE = 10;
const MAX_REGIONS = 16;
const MAX_COMPONENTS = 14;
const MAX_NAME = 80;

const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta', 'head']);

type ColorRole = PaletteColor['role'];

export interface DesignReadOptions {
  /** Bound the returned palette (defaults to {@link MAX_COLORS}). */
  readonly maxColors?: number;
}

/**
 * Extract a compact {@link DesignRead} from a loaded document. Deterministic and bounded: the
 * palette/type walk is capped at {@link MAX_ELEMENTS} elements and every returned list is
 * length-limited. Reads computed styles through `win.getComputedStyle`, so it resolves the real
 * cascade in a live page and the inline/default cascade under jsdom.
 */
export function extractDesignRead(
  doc: Document,
  win: Window,
  opts: DesignReadOptions = {},
): DesignRead {
  const elements = collectVisible(doc, win);
  return {
    url: doc.location?.href ?? '',
    title: (doc.title ?? '').trim().slice(0, 200),
    palette: palette(elements, win, opts.maxColors ?? MAX_COLORS),
    typography: typography(elements, win, doc),
    regions: regions(doc),
    components: components(doc),
  };
}

// --- element collection ---------------------------------------------------

function collectVisible(doc: Document, win: Window): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(doc.body?.querySelectorAll('*') ?? [])) {
    if (out.length >= MAX_ELEMENTS) break;
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
    if (!isVisible(el, win)) continue;
    out.push(el);
  }
  return out;
}

// Read a computed longhand via `getPropertyValue` (kebab-case), matching `src/dom/read.ts`. The
// camelCase accessors (`style.fontFamily`) return a UA placeholder under jsdom, whereas
// `getPropertyValue` resolves the actual cascaded value in both jsdom and a live page.
function cssProp(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
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

// --- palette --------------------------------------------------------------

// Per-role element counts for one normalized color, so a hex used as text and as a surface is
// merged into one entry whose `role` is whichever use dominates.
type RoleCounts = Record<ColorRole, number>;

function palette(elements: Element[], win: Window, maxColors: number): PaletteColor[] {
  const byHex = new Map<string, RoleCounts>();
  const bump = (hex: string | null, role: ColorRole): void => {
    if (!hex) return;
    const counts = byHex.get(hex) ?? { text: 0, background: 0, border: 0 };
    counts[role] += 1;
    byHex.set(hex, counts);
  };

  for (const el of elements) {
    const style = win.getComputedStyle(el);
    // Text color only counts where the element actually renders its own text, so container
    // inheritance doesn't drown the real ink color.
    if (hasDirectText(el)) bump(parseColor(cssProp(style, 'color')), 'text');
    bump(parseColor(cssProp(style, 'background-color')), 'background');
    // Border color only when a border is actually drawn (else it's currentColor noise).
    if (hasBorder(style)) bump(parseColor(cssProp(style, 'border-top-color')), 'border');
  }

  return [...byHex.entries()]
    .map(([hex, counts]) => ({ hex, role: dominantRole(counts), count: total(counts) }))
    .sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex))
    .slice(0, maxColors);
}

function hasBorder(style: CSSStyleDeclaration): boolean {
  const drawn = cssProp(style, 'border-top-style');
  return (
    drawn !== '' && drawn !== 'none' && parseFloat(cssProp(style, 'border-top-width') || '0') > 0
  );
}

function total(counts: RoleCounts): number {
  return counts.text + counts.background + counts.border;
}

function dominantRole(counts: RoleCounts): ColorRole {
  let role: ColorRole = 'text';
  let max = -1;
  for (const r of ['background', 'text', 'border'] as const) {
    if (counts[r] > max) {
      max = counts[r];
      role = r;
    }
  }
  return role;
}

/** Normalize a computed CSS color to lowercase `#rrggbb`, or `null` for transparent / `none` /
 *  unparseable — so the palette only ever carries real, comparable colors. */
export function parseColor(input: string | null | undefined): string | null {
  const value = (input ?? '').trim().toLowerCase();
  if (!value || value === 'transparent' || value === 'none') return null;

  const rgb = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgb?.[1]) {
    const parts = rgb[1].split(/[,\s/]+/).filter((p) => p !== '');
    const [r, g, b, a] = parts;
    if (a !== undefined && parseFloat(a) === 0) return null; // fully transparent
    return toHex(channel(r), channel(g), channel(b));
  }

  const hex = value.match(/^#([0-9a-f]{3,8})$/);
  if (hex?.[1]) return fromHex(hex[1]);

  return null; // named colors etc. — computed styles normalize to rgb(), so this is rare
}

function channel(part: string | undefined): number {
  const n = Math.round(parseFloat(part ?? '0'));
  return Number.isFinite(n) ? Math.min(255, Math.max(0, n)) : 0;
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function fromHex(digits: string): string | null {
  // #rgb / #rgba -> expand; #rrggbb / #rrggbbaa -> take rgb, honor a fully-transparent alpha.
  if (digits.length === 3 || digits.length === 4) {
    const [r, g, b, a] = digits;
    if (a === '0') return null;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (digits.length === 6 || digits.length === 8) {
    if (digits.length === 8 && digits.slice(6) === '00') return null;
    return `#${digits.slice(0, 6)}`;
  }
  return null;
}

// --- typography -----------------------------------------------------------

function typography(elements: Element[], win: Window, doc: Document): Typography {
  const families = new Map<string, number>();
  const sizes = new Set<number>();

  for (const el of elements) {
    if (!hasDirectText(el)) continue;
    const style = win.getComputedStyle(el);
    const family = primaryFamily(fontFamilyOf(el, style));
    if (family) families.set(family, (families.get(family) ?? 0) + 1);
    const size = Math.round(parseFloat(cssProp(style, 'font-size') || ''));
    if (Number.isFinite(size) && size > 0) sizes.add(size);
  }

  const baseSize = bodySize(doc, win);
  return {
    families: [...families.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_FAMILIES)
      .map(([name]) => name),
    scale: [...sizes].sort((a, b) => b - a).slice(0, MAX_SCALE),
    ...(baseSize !== null ? { baseSize } : {}),
  };
}

// jsdom's computed style returns this placeholder for `font-family` (it doesn't resolve the
// font cascade); treated as "no value" so the extractor falls back to the inline stack.
const UA_FONT_PLACEHOLDER = 'depends on user agent';

/** The font-family stack for `el`: the computed value in a live page, falling back to the
 *  element's inline value when the computed stack is unavailable (jsdom). */
function fontFamilyOf(el: Element, style: CSSStyleDeclaration): string {
  const computed = cssProp(style, 'font-family');
  if (computed && computed !== UA_FONT_PLACEHOLDER) return computed;
  return (el as Partial<ElementCSSInlineStyle>).style?.getPropertyValue('font-family') ?? '';
}

/** First family in a `font-family` stack, unquoted and trimmed (e.g. `"Inter", sans-serif`
 *  -> `Inter`), or `''` when empty / unresolved. */
export function primaryFamily(fontFamily: string | null | undefined): string {
  const raw = (fontFamily ?? '').trim();
  if (raw === '' || raw === UA_FONT_PLACEHOLDER) return '';
  const first = raw.split(',')[0]?.trim() ?? '';
  return first.replace(/^['"]|['"]$/g, '').trim();
}

function bodySize(doc: Document, win: Window): number | null {
  const root = doc.body ?? doc.documentElement;
  if (!root) return null;
  const size = Math.round(parseFloat(cssProp(win.getComputedStyle(root), 'font-size') || ''));
  return Number.isFinite(size) && size > 0 ? size : null;
}

// --- layout regions -------------------------------------------------------

// Landmark selector -> role. Mirrors the implicit-role mapping in read.ts's a11y snapshot, but
// flattened to the page's top-level regions rather than a full tree.
const LANDMARKS: readonly (readonly [string, string])[] = [
  ['header, [role="banner"]', 'banner'],
  ['nav, [role="navigation"]', 'navigation'],
  ['main, [role="main"]', 'main'],
  ['aside, [role="complementary"]', 'complementary'],
  ['footer, [role="contentinfo"]', 'contentinfo'],
  ['form, [role="form"]', 'form'],
  ['[role="search"]', 'search'],
  ['section[aria-label], section[aria-labelledby], [role="region"]', 'region'],
];

function regions(doc: Document): DesignRegion[] {
  const out: DesignRegion[] = [];
  const seen = new Set<string>();
  for (const [selector, role] of LANDMARKS) {
    for (const el of queryAll(doc, selector)) {
      if (out.length >= MAX_REGIONS) return out;
      const name = regionName(el);
      const key = `${role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ role, name });
    }
  }
  return out;
}

function regionName(el: Element): string {
  const label = el.getAttribute('aria-label')?.trim();
  if (label) return label.slice(0, MAX_NAME);
  const heading = el.querySelector('h1, h2, h3, h4, h5, h6');
  const text = heading?.textContent?.trim();
  return (text ?? '').slice(0, MAX_NAME);
}

// --- key components -------------------------------------------------------

// Component kind -> selector. Counts, not instances: the agent wants the vocabulary (how many
// buttons / inputs / cards), not each node. `queryAll` swallows an unsupported selector.
const COMPONENTS: readonly (readonly [string, string])[] = [
  [
    'button',
    'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]',
  ],
  ['link', 'a[href]'],
  [
    'input',
    'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select',
  ],
  ['heading', 'h1, h2, h3, h4, h5, h6, [role="heading"]'],
  ['image', 'img, svg, picture'],
  ['list', 'ul, ol'],
  ['table', 'table'],
  ['card', 'article, [class*="card" i]'],
  ['dialog', 'dialog, [role="dialog"], [role="alertdialog"]'],
  ['tab', '[role="tab"]'],
];

function components(doc: Document): DesignComponent[] {
  return COMPONENTS.map(([kind, selector]) => ({ kind, count: queryAll(doc, selector).length }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
    .slice(0, MAX_COMPONENTS);
}
