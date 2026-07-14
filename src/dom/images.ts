import { queryAll, queryOne } from '@/dom/read';
import { pickUnique } from '@/dom/selector';
import type { ImageInfo, ReadImagesResult, StableSelector } from '@/shared/messages';

// Image enumeration — the content script's "see what's on screen" read (slice 13 vision half).
// Walks `<img>` elements + CSS `background-image` under a scope, resolving each to a stable
// selector and its natural-vs-rendered size, and flags two signals the agent acts on:
//   • broken  — the image failed to load (`naturalWidth === 0` on a completed <img> with a src);
//   • oversized — intrinsic pixels dwarf the rendered box (wasted bytes / layout-shift risk).
// Pure DOM in, typed `ReadImagesResult` out (no chrome.*), so it runs under jsdom and the content
// entrypoint stays a thin wire. Bounds cap a hostile or image-heavy page's payload the same way
// DiagnosticsToolResult / DesignRead do.

const MAX_IMAGES = 200; // matches ReadImagesResult's schema bound
const MAX_SCAN = 3_000; // background-image sweep cap (one getComputedStyle per element)
const OVERSIZE_FACTOR = 2; // intrinsic > this × the device-pixel-accurate rendered size = wasteful
const MAX_SRC = 2048;
const MAX_ALT = 500;

/** Enumerate every image under `root` (an element scope or the whole document). */
export function readImages(root: ParentNode, win: Window = window): ReadImagesResult {
  const doc = documentOf(root);
  const dpr = win.devicePixelRatio || 1;
  const images: ImageInfo[] = [];
  const seen = new Set<Element>();

  for (const el of imgElements(root)) {
    if (images.length >= MAX_IMAGES) break;
    seen.add(el);
    images.push(describeImg(el, doc, dpr));
  }

  let scanned = 0;
  for (const el of backgroundCandidates(root)) {
    if (images.length >= MAX_IMAGES || scanned >= MAX_SCAN) break;
    scanned += 1;
    if (seen.has(el)) continue;
    const src = backgroundUrl(el, win);
    if (src) images.push(describeBackground(el, src, doc));
  }

  return { images };
}

// pickUnique scopes uniqueness against the owning document; a scope Element resolves through its
// ownerDocument, a Document is its own root.
function documentOf(root: ParentNode): ParentNode {
  if (typeof Document !== 'undefined' && root instanceof Document) return root;
  return (root as { ownerDocument?: Document | null }).ownerDocument ?? root;
}

function imgElements(root: ParentNode): HTMLImageElement[] {
  const list: HTMLImageElement[] = [];
  if (root instanceof HTMLImageElement) list.push(root); // querySelectorAll excludes the scope node
  for (const el of queryAll(root, 'img')) {
    if (el instanceof HTMLImageElement) list.push(el);
  }
  return list;
}

function backgroundCandidates(root: ParentNode): Element[] {
  const descendants = queryAll(root, '*');
  return root instanceof Element ? [root, ...descendants] : descendants;
}

function backgroundUrl(el: Element, win: Window): string | null {
  // Computed style is the source of truth (it resolves class-driven backgrounds too); fall back to
  // the inline value when the computed layer doesn't surface it (e.g. jsdom's partial CSSOM).
  const computed = win.getComputedStyle(el).backgroundImage;
  const inline = el instanceof HTMLElement ? el.style.backgroundImage : '';
  const bg = computed && computed !== 'none' ? computed : inline;
  if (!bg || bg === 'none') return null;
  const raw = bg.match(/url\((['"]?)([^'")]+)\1\)/)?.[2];
  return raw ? absolutize(raw, el) : null;
}

function absolutize(raw: string, el: Element): string {
  try {
    return new URL(raw, el.ownerDocument?.baseURI).href.slice(0, MAX_SRC);
  } catch {
    return raw.slice(0, MAX_SRC);
  }
}

function isOversized(nw: number, nh: number, rw: number, rh: number, dpr: number): boolean {
  if (rw <= 0 || rh <= 0) return false; // not laid out — can't judge intrinsic vs rendered
  return nw > rw * dpr * OVERSIZE_FACTOR || nh > rh * dpr * OVERSIZE_FACTOR;
}

function describeImg(el: HTMLImageElement, doc: ParentNode, dpr: number): ImageInfo {
  const rect = el.getBoundingClientRect();
  const naturalWidth = el.naturalWidth || 0;
  const naturalHeight = el.naturalHeight || 0;
  const src = (el.currentSrc || el.src || el.getAttribute('src') || '').slice(0, MAX_SRC);
  const alt = el.getAttribute('alt');
  const broken = Boolean(src) && el.complete === true && naturalWidth === 0;
  return {
    selector: pickUnique(el, doc),
    kind: 'img',
    src,
    ...(alt !== null ? { alt: alt.slice(0, MAX_ALT) } : {}),
    naturalWidth,
    naturalHeight,
    renderedWidth: rect.width,
    renderedHeight: rect.height,
    broken,
    oversized: !broken && isOversized(naturalWidth, naturalHeight, rect.width, rect.height, dpr),
  };
}

// The DOM leg of the `readImageContent` tool (slice 14): one image resolved to its stable selector,
// source URL, and alt text so the SW can add a vision prose description (the alt is the cheap
// non-vision fallback). An `<img>` yields its rendered `src` + `alt`; any other element is treated as
// a CSS-background image (its `background-image` URL + `aria-label`/`alt`). Bounds match `readImages`.
export interface ImageContent {
  readonly selector: StableSelector;
  readonly src: string;
  readonly alt?: string;
}

/** Resolve the single element matching `selector` under `root` to its {@link ImageContent}, or `null`
 *  when nothing matches. Pure DOM (no chrome.*), so it runs under jsdom and keeps content a thin wire. */
export function imageContent(
  root: ParentNode,
  selector: string,
  win: Window = window,
): ImageContent | null {
  const el = queryOne(root, selector);
  if (!el) return null;
  const doc = documentOf(root);
  const sel = pickUnique(el, doc);

  if (el instanceof HTMLImageElement) {
    const src = (el.currentSrc || el.src || el.getAttribute('src') || '').slice(0, MAX_SRC);
    const alt = el.getAttribute('alt');
    return { selector: sel, src, ...(alt !== null ? { alt: alt.slice(0, MAX_ALT) } : {}) };
  }

  const bg = backgroundUrl(el, win) ?? '';
  const label = el.getAttribute('aria-label') ?? el.getAttribute('alt');
  return { selector: sel, src: bg, ...(label ? { alt: label.slice(0, MAX_ALT) } : {}) };
}

function describeBackground(el: Element, src: string, doc: ParentNode): ImageInfo {
  const rect = el.getBoundingClientRect();
  return {
    selector: pickUnique(el, doc),
    kind: 'background',
    src,
    // A CSS background exposes no intrinsic size or load state from the DOM — report position/size
    // and leave the load-derived signals off rather than guess.
    naturalWidth: 0,
    naturalHeight: 0,
    renderedWidth: rect.width,
    renderedHeight: rect.height,
    broken: false,
    oversized: false,
  };
}
