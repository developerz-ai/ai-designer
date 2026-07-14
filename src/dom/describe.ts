import { queryAll } from '@/dom/read';

// Describe-in-text extractor — turns a page or region into a compact, token-bounded *text*
// description so a non-vision model, a report, or a handoff spec can reason without pixels. Pure DOM
// in, a plain string out: no chrome.*, so every branch runs under jsdom and the content entrypoint
// (coverage-excluded) stays a thin dispatcher. Powers the `describe` tool's cheap DOM-only modes
// (plan slice 14); the `scene` mode instead screenshots + asks the vision model in the SW and never
// touches this module.
//
//   layout  → structural skeleton: landmark regions (nav/main/footer) + per-region component
//             counts + a heading outline.
//   content → salient copy: title/description, headings, button + link labels, leading paragraphs.

export type DescribeMode = 'layout' | 'content';

export interface DescribeResult {
  readonly mode: DescribeMode;
  /** Compact description, clipped to the char budget. */
  readonly text: string;
}

export interface DescribeOptions {
  /** Hard cap on the returned text (defaults to {@link MAX_CHARS}). */
  readonly maxChars?: number;
}

const MAX_REGIONS = 16;
const MAX_HEADINGS = 20;
const MAX_LIST = 12;
const MAX_PARAS = 5;
const MAX_NAME = 80;
const MAX_HEADING = 100;
const MAX_LABEL = 60;
const MAX_COPY = 400;
const MAX_CHARS = 2000;

// Landmark elements (implicit-role tags + explicit ARIA roles). A combined selector, so
// querySelectorAll returns them in document order for free.
const LANDMARK_SELECTOR = [
  'header',
  'nav',
  'main',
  'aside',
  'footer',
  'form',
  'section',
  '[role="banner"]',
  '[role="navigation"]',
  '[role="main"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  '[role="form"]',
  '[role="search"]',
  '[role="region"]',
].join(', ');

const IMPLICIT_LANDMARK: Record<string, string> = {
  header: 'banner',
  nav: 'navigation',
  main: 'main',
  aside: 'complementary',
  footer: 'contentinfo',
  form: 'form',
  section: 'region',
};

const LANDMARK_ROLES = new Set([
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'form',
  'search',
  'region',
]);

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const BUTTON_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"]';

// Component kinds counted per region in layout mode.
const COUNTED: readonly (readonly [string, string])[] = [
  ['heading', 'h1, h2, h3, h4, h5, h6, [role="heading"]'],
  ['button', BUTTON_SELECTOR],
  ['link', 'a[href]'],
  [
    'input',
    'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="hidden"]), textarea, select',
  ],
  ['image', 'img, svg, picture'],
  ['list', 'ul, ol'],
];

/**
 * Build a compact text {@link DescribeResult} for `root` (a Document for the whole page, or an
 * Element for a region) in the given `mode`. Deterministic, bounded, and clipped to a char budget so
 * a large page can't blow the agent's token budget. The `scene` mode is intentionally absent — it
 * lives in the service worker's vision path, not this DOM-only module.
 */
export function describePage(
  root: ParentNode,
  mode: DescribeMode,
  opts: DescribeOptions = {},
): DescribeResult {
  const text = mode === 'layout' ? layoutText(root) : contentText(root);
  return { mode, text: clip(text, opts.maxChars ?? MAX_CHARS) };
}

// --- layout ---------------------------------------------------------------

function layoutText(root: ParentNode): string {
  const lines: string[] = [];
  const landmarks = collectLandmarks(root);
  if (landmarks.length > 0) {
    lines.push(`Layout: ${landmarks.map((l) => l.role).join(' › ')}`);
    for (const { el, role } of landmarks) {
      const name = regionName(el);
      const head = name ? `${role} "${name}"` : role;
      const counts = componentCounts(el);
      lines.push(counts ? `- ${head}: ${counts}` : `- ${head}`);
    }
  }

  const outline = headingOutline(root);
  if (outline.length > 0) {
    lines.push('Headings:');
    lines.push(...outline);
  }

  return lines.length > 0 ? lines.join('\n') : 'No landmarks or headings found.';
}

function collectLandmarks(root: ParentNode): { el: Element; role: string }[] {
  const out: { el: Element; role: string }[] = [];
  for (const el of queryAll(root, LANDMARK_SELECTOR)) {
    if (out.length >= MAX_REGIONS) break;
    const role = landmarkRole(el);
    if (role) out.push({ el, role });
  }
  return out;
}

function landmarkRole(el: Element): string | null {
  const explicit = el.getAttribute('role')?.trim().toLowerCase();
  if (explicit) return LANDMARK_ROLES.has(explicit) ? explicit : null;
  const tag = el.tagName.toLowerCase();
  const implicit = IMPLICIT_LANDMARK[tag];
  if (!implicit) return null;
  // A bare <section>/<form> is only a landmark region when it carries an accessible name.
  if ((tag === 'section' || tag === 'form') && !accessibleName(el)) return null;
  return implicit;
}

function componentCounts(el: Element): string {
  const parts: string[] = [];
  for (const [kind, selector] of COUNTED) {
    const n = queryAll(el, selector).length;
    if (n > 0) parts.push(`${n} ${plural(kind, n)}`);
  }
  return parts.join(', ');
}

function headingOutline(root: ParentNode): string[] {
  const out: string[] = [];
  for (const h of queryAll(root, HEADING_SELECTOR)) {
    if (out.length >= MAX_HEADINGS) break;
    const text = clip(textOf(h), MAX_HEADING);
    if (!text) continue;
    const level = Number(h.tagName[1] ?? '1');
    out.push(`${'  '.repeat(Math.max(0, level - 1))}h${level} ${text}`);
  }
  return out;
}

// --- content --------------------------------------------------------------

function contentText(root: ParentNode): string {
  const lines: string[] = [];

  if (isDocument(root)) {
    const title = clip((root.title ?? '').trim(), MAX_NAME);
    if (title) lines.push(`Title: ${title}`);
    const desc = metaDescription(root);
    if (desc) lines.push(`Description: ${clip(desc, MAX_COPY)}`);
  }

  const headings = dedupe(
    queryAll(root, HEADING_SELECTOR)
      .map((h) => clip(textOf(h), MAX_HEADING))
      .filter((t) => t !== ''),
  ).slice(0, MAX_LIST);
  if (headings.length > 0) lines.push(`Headings: ${headings.join('; ')}`);

  const buttons = labels(root, BUTTON_SELECTOR);
  if (buttons) lines.push(`Buttons: ${buttons}`);

  const links = labels(root, 'a[href]');
  if (links) lines.push(`Links: ${links}`);

  const copy = leadingCopy(root);
  if (copy) lines.push(`Copy: ${copy}`);

  return lines.length > 0 ? lines.join('\n') : 'No salient text content found.';
}

// Deduped, bounded control labels with an overflow marker (`Sign up; Log in; …(+3)`).
function labels(root: ParentNode, selector: string): string {
  const all = dedupe(
    queryAll(root, selector)
      .map((el) => clip(controlLabel(el), MAX_LABEL))
      .filter((label) => label !== ''),
  );
  if (all.length === 0) return '';
  const shown = all.slice(0, MAX_LIST).join('; ');
  const more = all.length - MAX_LIST;
  return more > 0 ? `${shown}; …(+${more})` : shown;
}

function controlLabel(el: Element): string {
  const aria = accessibleName(el);
  if (aria) return aria;
  const text = textOf(el);
  if (text) return text;
  return (el.getAttribute('value') ?? el.getAttribute('placeholder') ?? '').trim();
}

function leadingCopy(root: ParentNode): string {
  const parts: string[] = [];
  let chars = 0;
  for (const p of queryAll(root, 'p')) {
    const text = textOf(p);
    if (!text) continue;
    parts.push(text);
    chars += text.length;
    if (chars >= MAX_COPY || parts.length >= MAX_PARAS) break;
  }
  return clip(parts.join(' '), MAX_COPY);
}

function metaDescription(doc: Document): string {
  return (doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '').trim();
}

// --- accessible naming ----------------------------------------------------

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

  return '';
}

// A region's name: its accessible name, else its first heading's text.
function regionName(el: Element): string {
  const name = accessibleName(el);
  if (name) return clip(name, MAX_NAME);
  const heading = el.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
  return clip(heading ? textOf(heading) : '', MAX_NAME);
}

// --- helpers --------------------------------------------------------------

function isDocument(root: ParentNode): root is Document {
  return root.nodeType === 9; // DOCUMENT_NODE
}

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function plural(word: string, n: number): string {
  return n === 1 ? word : `${word}s`;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** Trim `s` to `max` chars, appending an ellipsis when truncated. */
function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
