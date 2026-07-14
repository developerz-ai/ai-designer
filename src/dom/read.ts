import { pickUnique } from '@/dom/selector';
import type { A11yNode, A11yResult, GetStylesResult, QueryResult, Rect } from '@/shared/messages';

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

/** The crop rect the SW needs to capture `el` (or the whole viewport when omitted). */
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
