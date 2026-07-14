import { parseColor } from '@/dom/design-read';
import { queryAll } from '@/dom/read';
import { pickUnique } from '@/dom/selector';
import type { A11yImpact, CollectorSignal } from '@/shared/diagnostics';

// Diagnostics collectors — the content half of the debug engine (plan 06). Two independent
// responsibilities, both pure DOM / injectable so every branch runs under jsdom and the content
// entrypoint (coverage-excluded) stays a thin wire:
//
//  1. `createDiagnosticsCollector` — page-world-safe runtime + network hooks that BUFFER signals
//     (console errors/warnings, uncaught exceptions, unhandled rejections, failed/slow requests,
//     broken assets). "Page-world-safe" = it never breaks the page: every wrapper calls the
//     original through, swallows only its OWN bookkeeping errors, is bounded, and is fully
//     RESTORABLE on `dispose`. All global mutation is confined to an injected `HookTarget`
//     (`defaultHookTarget` wires the real globals); the collector itself is pure bookkeeping, so
//     tests drive it with a fake target and no `chrome.*` / real `fetch`.
//  2. `scanA11y` / `scanLayout` — point-in-time DOM scans that read the accessibility + layout
//     state directly. `scanLayout` takes an injected `LayoutProbe` for geometry (jsdom has no
//     layout engine, so a fake probe supplies rects in tests; `domLayoutProbe` reads the real DOM).
//
// NOTE on worlds: Chrome runs content scripts in an ISOLATED world, so hooks installed here on the
// isolated `window`/`fetch` see the extension world, not the page's own `console`/`fetch`. Because
// every hook targets an injected surface, the SAME collector drops into the MAIN world unchanged
// once the MAIN-world bridge lands (PR that adds page-facts) — that's what turns these into true
// page-world capture. The a11y/layout scans read the shared DOM and work from either world today.

// --- runtime + network collector ------------------------------------------

// The failure modes a network hook can report — the value half of `NetworkFailureKind`, inlined so
// this content module carries no dependency on the schema's inferred union just for a string type.
type NetworkFailure = 'http' | 'network' | 'timeout' | 'cors' | 'abort';

/** The result of one intercepted request the network hook reports to the collector. */
export interface FetchOutcome {
  method: string;
  url: string;
  ok: boolean;
  status?: number;
  durationMs?: number;
  failure?: NetworkFailure;
}

/** The global surfaces the collector hooks, injected so all world-coupling lives in one adapter
 *  (`defaultHookTarget`) and the collector stays a pure, testable buffer. Each `on*` installs a
 *  hook and returns a restore function; `dispose` calls them all. */
export interface HookTarget {
  now(): number;
  /** Subscribe to a window event (`error` with capture=true also catches resource-load failures).
   *  Returns an unsubscribe. */
  onWindowEvent(type: 'error' | 'unhandledrejection', handler: (ev: unknown) => void): () => void;
  /** Wrap `console[level]`, calling `handler(args)` before delegating. Returns a restore. */
  onConsole(level: 'error' | 'warn', handler: (args: unknown[]) => void): () => void;
  /** Wrap `fetch`, reporting each call's outcome. Returns a restore (no-op if `fetch` is absent). */
  onFetch(handler: (outcome: FetchOutcome) => void): () => void;
}

export interface CollectorOptions {
  /** Global surfaces to hook (defaults to the real ones via {@link defaultHookTarget}). */
  target?: HookTarget;
  /** Ring-buffer cap; the oldest signal is evicted past this (default {@link DEFAULT_MAX_BUFFER}). */
  maxBuffer?: number;
  /** A successful request slower than this is buffered as a perf signal (default
   *  {@link SLOW_REQUEST_MS}). Faster successes are dropped — only problems are kept. */
  slowMs?: number;
}

export interface CollectorHandle {
  /** A copy of everything buffered so far (non-destructive — for a mid-turn peek). */
  snapshot(): CollectorSignal[];
  /** Buffered signals, clearing the buffer — the SW pulls between reproduction steps. */
  drain(): CollectorSignal[];
  /** Restore every hooked global and stop buffering. Idempotent. */
  dispose(): void;
}

export const DEFAULT_MAX_BUFFER = 300;
export const SLOW_REQUEST_MS = 3000;

/**
 * Install the runtime + network hooks and start buffering diagnostics signals. Returns a handle to
 * read/drain the buffer and to restore every global on teardown. Safe to run on any page: the hooks
 * are non-destructive, bounded, and reversible.
 */
export function createDiagnosticsCollector(opts: CollectorOptions = {}): CollectorHandle {
  const target = opts.target ?? defaultHookTarget();
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const slowMs = opts.slowMs ?? SLOW_REQUEST_MS;

  let buffer: CollectorSignal[] = [];
  let disposed = false;
  const restores: Array<() => void> = [];

  const push = (signal: CollectorSignal): void => {
    if (disposed) return;
    buffer.push(signal);
    if (buffer.length > maxBuffer) buffer.splice(0, buffer.length - maxBuffer); // evict oldest
  };

  restores.push(
    target.onConsole('error', (args) => push(consoleSignal('error', args, target.now()))),
    target.onConsole('warn', (args) => push(consoleSignal('warn', args, target.now()))),
    target.onWindowEvent('error', (ev) => {
      const signal = errorEventSignal(ev, target.now());
      if (signal) push(signal);
    }),
    target.onWindowEvent('unhandledrejection', (ev) => {
      push(rejectionSignal(rejectionReason(ev), target.now()));
    }),
    target.onFetch((outcome) => {
      const signal = networkSignal(outcome, slowMs, target.now());
      if (signal) push(signal);
    }),
  );

  return {
    snapshot: () => [...buffer],
    drain: () => {
      const out = buffer;
      buffer = [];
      return out;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const restore of restores.splice(0)) {
        try {
          restore();
        } catch {
          // A restore that throws must not block the others — best-effort teardown.
        }
      }
    },
  };
}

// --- signal shaping (pure) ------------------------------------------------

function consoleSignal(level: 'error' | 'warn', args: unknown[], ts: number): CollectorSignal {
  return { kind: 'console', level, text: stringifyArgs(args).slice(0, 2000), ts };
}

/** An `error` event is either an uncaught exception (has a `message`) or a resource-load failure
 *  (an `<img>`/`<script>`/`<link>` that 404'd — a broken asset, reported as a network signal). */
export function errorEventSignal(ev: unknown, ts: number): CollectorSignal | null {
  const e = ev as {
    message?: unknown;
    filename?: unknown;
    lineno?: unknown;
    colno?: unknown;
    error?: { stack?: unknown };
    target?: unknown;
  };
  const message = typeof e.message === 'string' ? e.message.trim() : '';
  if (message) {
    return {
      kind: 'exception',
      message: message.slice(0, 2000),
      ...(typeof e.filename === 'string' && e.filename
        ? { source: e.filename.slice(0, 2048) }
        : {}),
      ...(typeof e.lineno === 'number' ? { line: e.lineno } : {}),
      ...(typeof e.colno === 'number' ? { column: e.colno } : {}),
      ...(typeof e.error?.stack === 'string' ? { stack: e.error.stack.slice(0, 4000) } : {}),
      ts,
    };
  }
  const asset = brokenAssetUrl(e.target);
  if (asset) {
    return {
      kind: 'network',
      method: 'GET',
      url: asset.slice(0, 2048),
      ok: false,
      failure: 'network',
      ts,
    };
  }
  return null;
}

/** The failing resource's URL when an `error` event targets a media/script/link element, else null. */
function brokenAssetUrl(target: unknown): string | null {
  if (!target || typeof target !== 'object') return null;
  const el = target as { tagName?: unknown; src?: unknown; href?: unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
  if (['img', 'script', 'source', 'video', 'audio', 'track', 'iframe', 'embed'].includes(tag)) {
    return typeof el.src === 'string' && el.src ? el.src : null;
  }
  if (tag === 'link') return typeof el.href === 'string' && el.href ? el.href : null;
  return null;
}

export function rejectionReason(ev: unknown): string {
  const reason = (ev as { reason?: unknown }).reason;
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  if (typeof reason === 'string') return reason;
  return stringifyArgs([reason]);
}

function rejectionSignal(reason: string, ts: number): CollectorSignal {
  return { kind: 'rejection', reason: reason.slice(0, 2000), ts };
}

/** A request outcome → a network signal, or null when it's a fast success (only problems are kept:
 *  any failure, or a success slower than `slowMs`). */
export function networkSignal(o: FetchOutcome, slowMs: number, ts: number): CollectorSignal | null {
  const slow = o.durationMs !== undefined && o.durationMs >= slowMs;
  if (o.ok && !slow) return null;
  return {
    kind: 'network',
    method: (o.method || 'GET').toUpperCase().slice(0, 12),
    url: o.url.slice(0, 2048),
    ok: o.ok,
    ...(o.status !== undefined ? { status: o.status } : {}),
    ...(o.durationMs !== undefined ? { durationMs: Math.round(o.durationMs) } : {}),
    ...(o.failure ? { failure: o.failure } : {}),
    ts,
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ')
    .trim();
}

// --- fetch classification (pure, exported for tests) ----------------------

/** Best-effort URL of a `fetch` argument (string, `URL`, or `Request`). */
export function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) {
    const url = (input as { url?: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return '';
}

/** The HTTP method of a `fetch` call (`init.method` wins, then a `Request`'s method, else GET). */
export function requestMethod(input: unknown, init: unknown): string {
  const fromInit = (init as { method?: unknown } | undefined)?.method;
  if (typeof fromInit === 'string' && fromInit) return fromInit;
  if (input && typeof input === 'object' && 'method' in input) {
    const method = (input as { method?: unknown }).method;
    if (typeof method === 'string' && method) return method;
  }
  return 'GET';
}

/** Classify a thrown `fetch` rejection. Only `abort` is reliably detectable client-side; a generic
 *  "Failed to fetch" `TypeError` covers DNS/connection/CORS indistinguishably, so it maps to the
 *  broad `network` failure rather than over-claiming `cors`. */
export function classifyFetchError(err: unknown): NetworkFailure {
  const name = (err as { name?: unknown })?.name;
  if (name === 'AbortError') return 'abort';
  if (name === 'TimeoutError') return 'timeout';
  return 'network';
}

// --- default hook target (real globals) -----------------------------------

/** Wire the collector to the real page globals. This is the only world-coupled code here; it
 *  contains the typed global mutation (assigning `console[level]` / `fetch`) so the collector and
 *  its signal-shaping stay pure. */
export function defaultHookTarget(): HookTarget {
  return {
    now: () => Date.now(),
    onWindowEvent: (type, handler) => {
      const listener = (ev: Event): void => {
        try {
          handler(ev);
        } catch {
          // Never let our bookkeeping throw into the page's event dispatch.
        }
      };
      // capture=true so resource-load errors (which don't bubble) are caught too.
      window.addEventListener(type, listener, true);
      return () => window.removeEventListener(type, listener, true);
    },
    onConsole: (level, handler) => {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]): void => {
        try {
          handler(args);
        } catch {
          // Bookkeeping must not suppress the page's own logging.
        }
        original(...args);
      };
      return () => {
        console[level] = original;
      };
    },
    onFetch: (handler) => {
      const scope = globalThis as { fetch?: typeof fetch };
      const original = scope.fetch;
      if (!original) return () => {};
      const bound = original.bind(globalThis);
      const now = (): number => Date.now();
      const wrapped: typeof fetch = async (input, init) => {
        const url = requestUrl(input);
        const method = requestMethod(input, init);
        const start = now();
        try {
          const res = await bound(input, init);
          report(handler, {
            method,
            url,
            ok: res.ok,
            status: res.status,
            durationMs: now() - start,
          });
          return res;
        } catch (err) {
          report(handler, {
            method,
            url,
            ok: false,
            durationMs: now() - start,
            failure: classifyFetchError(err),
          });
          throw err; // the page's own error handling must see the real rejection
        }
      };
      scope.fetch = wrapped;
      return () => {
        scope.fetch = original;
      };
    },
  };
}

function report(handler: (o: FetchOutcome) => void, outcome: FetchOutcome): void {
  try {
    handler(outcome);
  } catch {
    // Bookkeeping error — the request result is already handed back to the caller untouched.
  }
}

// --- accessibility scan (pure DOM) ----------------------------------------

const MAX_FINDINGS = 60; // cap total scan output so one broken page can't flood the buffer
const MAX_ELEMENTS = 4000; // cap per-pass element walk on a huge DOM

const INTERACTIVE_SELECTOR =
  'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"]';
const FIELD_SELECTOR =
  'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]), select, textarea';

export interface ScanOptions {
  /** Clock for signal timestamps (default `Date.now`) — injected so tests are deterministic. */
  now?: () => number;
  /** Scan root (default the document); the selector each finding carries is still resolved against
   *  the whole document so it stays globally unique. */
  root?: ParentNode;
}

/**
 * Scan the accessibility state of the page and return one signal per violation: interactive
 * controls with no accessible name, images with no `alt`, form fields with no label, positive
 * `tabindex` (focus-order breakage), a missing document `lang`, and low text/background contrast.
 * Pure DOM + computed styles, so it runs under jsdom; bounded in both element walk and output.
 */
export function scanA11y(doc: Document, win: Window, opts: ScanOptions = {}): CollectorSignal[] {
  const now = opts.now ?? (() => Date.now());
  const root = opts.root ?? doc;
  const out: CollectorSignal[] = [];
  const add = (rule: string, impact: A11yImpact, detail: string, el: Element): void => {
    if (out.length >= MAX_FINDINGS) return;
    out.push({
      kind: 'a11y',
      rule,
      impact,
      detail: detail.slice(0, 400),
      selector: pickUnique(el, doc),
      ts: now(),
    });
  };

  const html = doc.documentElement;
  if (html && !(html.getAttribute('lang') ?? '').trim()) {
    add(
      'html-lang',
      'moderate',
      'The document has no lang attribute, so assistive tech cannot announce its language.',
      html,
    );
  }

  for (const el of capped(queryAll(root, INTERACTIVE_SELECTOR))) {
    if (isHiddenFromA11y(el)) continue;
    if (accessibleName(el) === '') {
      add(
        'control-name',
        'serious',
        `<${tagName(el)}> control has no accessible name (no text, aria-label, or title).`,
        el,
      );
    }
  }

  for (const el of capped(queryAll(root, FIELD_SELECTOR))) {
    if (isHiddenFromA11y(el)) continue;
    if (!hasFieldLabel(el, doc)) {
      add('field-label', 'serious', `<${tagName(el)}> form field has no associated label.`, el);
    }
  }

  for (const img of capped(queryAll(root, 'img'))) {
    if (isHiddenFromA11y(img)) continue;
    if (!img.hasAttribute('alt')) {
      add(
        'image-alt',
        'serious',
        'Image has no alt attribute (use alt="" if it is decorative).',
        img,
      );
    }
  }

  for (const el of capped(queryAll(root, '[tabindex]'))) {
    const tabindex = Number.parseInt(el.getAttribute('tabindex') ?? '', 10);
    if (Number.isFinite(tabindex) && tabindex > 0) {
      add(
        'focus-order',
        'moderate',
        `Positive tabindex (${tabindex}) forces an unnatural focus order.`,
        el,
      );
    }
  }

  scanContrast(root, win, add);
  return out;
}

function scanContrast(
  root: ParentNode,
  win: Window,
  add: (rule: string, impact: A11yImpact, detail: string, el: Element) => void,
): void {
  let scanned = 0;
  for (const el of queryAll(
    root,
    'p, span, a, li, h1, h2, h3, h4, h5, h6, button, label, td, th',
  )) {
    if (scanned++ >= MAX_ELEMENTS) break;
    if (!hasDirectText(el) || isHiddenFromA11y(el)) continue;
    const style = win.getComputedStyle(el);
    const fg = parseColor(style.getPropertyValue('color'));
    const bg = effectiveBackground(el, win);
    if (!fg || !bg) continue; // only judge when both colors are known + opaque (avoid false positives)
    const ratio = contrastRatio(fg, bg);
    const min = isLargeText(style) ? 3 : 4.5;
    if (ratio < min) {
      add(
        'contrast',
        ratio < min - 1.5 ? 'serious' : 'moderate',
        `Text contrast ${ratio.toFixed(2)}:1 (${fg} on ${bg}) is below the ${min}:1 WCAG AA minimum.`,
        el,
      );
    }
  }
}

// --- layout scan (pure DOM + injected geometry) ---------------------------

/** Geometry the layout scan needs. Injected because jsdom has no layout engine (every real rect
 *  is 0), so tests supply a fake probe; `domLayoutProbe` reads the live DOM in the content world. */
export interface LayoutProbe {
  viewportWidth(): number;
  /** Full scroll width of an element (page overflow uses the document element's). */
  scrollWidth(el: Element): number;
  /** The element's right edge in CSS px relative to the viewport left. */
  right(el: Element): number;
}

export function domLayoutProbe(win: Window): LayoutProbe {
  return {
    viewportWidth: () => win.innerWidth,
    scrollWidth: (el) => (el as HTMLElement).scrollWidth,
    right: (el) => el.getBoundingClientRect().right,
  };
}

export interface LayoutScanOptions extends ScanOptions {
  probe?: LayoutProbe;
}

const OVERFLOW_FUZZ = 2; // px of sub-pixel slack before calling it real horizontal overflow

/**
 * Scan for layout problems: horizontal page overflow, individual elements spilling past the
 * viewport's right edge, and images with no intrinsic size hint (a CLS risk). Geometry comes from
 * an injected {@link LayoutProbe}; the CLS check is attribute/style-based so it needs no geometry.
 */
export function scanLayout(
  doc: Document,
  win: Window,
  opts: LayoutScanOptions = {},
): CollectorSignal[] {
  const now = opts.now ?? (() => Date.now());
  const root = opts.root ?? doc;
  const probe = opts.probe ?? domLayoutProbe(win);
  const out: CollectorSignal[] = [];
  const add = (rule: string, detail: string, el: Element): void => {
    if (out.length >= MAX_FINDINGS) return;
    out.push({
      kind: 'layout',
      rule,
      detail: detail.slice(0, 400),
      selector: pickUnique(el, doc),
      ts: now(),
    });
  };

  const vw = probe.viewportWidth();
  const de = doc.documentElement;
  if (de && probe.scrollWidth(de) > vw + OVERFLOW_FUZZ) {
    add(
      'overflow-x',
      `The page scrolls horizontally: content is ${probe.scrollWidth(de)}px wide in a ${vw}px viewport.`,
      de,
    );
  }

  for (const el of capped(
    queryAll(root, 'img, video, iframe, table, pre, canvas, svg, section, header, footer'),
  )) {
    if (probe.right(el) > vw + OVERFLOW_FUZZ) {
      add(
        'overflow-x',
        `<${tagName(el)}> extends past the ${vw}px viewport (right edge at ${Math.round(probe.right(el))}px).`,
        el,
      );
    }
  }

  for (const img of capped(queryAll(root, 'img'))) {
    if (!(img.getAttribute('src') ?? '').trim()) continue;
    if (missingIntrinsicSize(img)) {
      add(
        'cls-image',
        'Image has no width/height attribute or CSS size — it can shift layout as it loads (CLS).',
        img,
      );
    }
  }

  return out;
}

// --- shared DOM helpers ---------------------------------------------------

function capped(els: Element[]): Element[] {
  return els.length > MAX_ELEMENTS ? els.slice(0, MAX_ELEMENTS) : els;
}

function tagName(el: Element): string {
  return el.tagName.toLowerCase();
}

function hasDirectText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 && (node.textContent ?? '').trim() !== '') return true;
  }
  return false;
}

function isHiddenFromA11y(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.hasAttribute('hidden')) return true;
  const style = (el as Partial<ElementCSSInlineStyle>).style;
  return style?.getPropertyValue('display') === 'none';
}

/** The accessible name of `el` (aria-label → aria-labelledby → alt → title → trimmed text). Mirrors
 *  the read.ts precedence, bounded so one huge node can't blow the signal. */
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

  if (tagName(el) === 'img') return (el.getAttribute('alt') ?? '').trim();

  const title = el.getAttribute('title')?.trim();
  if (title) return title;

  const value = el.getAttribute('value')?.trim();
  if (
    value &&
    ['button', 'submit', 'reset'].includes((el.getAttribute('type') ?? '').toLowerCase())
  ) {
    return value;
  }

  return (el.textContent ?? '').trim().slice(0, 200);
}

function hasFieldLabel(el: Element, doc: Document): boolean {
  if ((el.getAttribute('aria-label') ?? '').trim()) return true;
  if ((el.getAttribute('aria-labelledby') ?? '').trim()) return true;
  if ((el.getAttribute('title') ?? '').trim()) return true;
  if (el.closest('label')) return true;
  const id = el.getAttribute('id');
  if (id) {
    const escaped = cssEscape(id);
    if (escaped && doc.querySelector(`label[for="${escaped}"]`)) return true;
  }
  return false;
}

function cssEscape(value: string): string {
  const api = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (api?.escape) return api.escape(value);
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : '';
}

function missingIntrinsicSize(img: Element): boolean {
  if (img.hasAttribute('width') || img.hasAttribute('height')) return false;
  const style = (img as Partial<ElementCSSInlineStyle>).style;
  if (!style) return true;
  return (
    !style.getPropertyValue('width') &&
    !style.getPropertyValue('height') &&
    !style.getPropertyValue('aspect-ratio')
  );
}

function effectiveBackground(el: Element, win: Window): string | null {
  let node: Element | null = el;
  let hops = 0;
  while (node && hops++ < 20) {
    const color = parseColor(win.getComputedStyle(node).getPropertyValue('background-color'));
    if (color) return color;
    node = node.parentElement;
  }
  return null;
}

function isLargeText(style: CSSStyleDeclaration): boolean {
  const size = Number.parseFloat(style.getPropertyValue('font-size') || '0');
  const weight = Number.parseInt(style.getPropertyValue('font-weight') || '400', 10);
  const bold = weight >= 700;
  return size >= 24 || (size >= 18.66 && bold);
}

/** WCAG relative-luminance contrast ratio between two `#rrggbb` colors (1–21). */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const [light, dark] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (light + 0.05) / (dark + 0.05);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = rgbChannels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function rgbChannels(hex: string): [number, number, number] {
  const digits = hex.replace('#', '');
  const r = Number.parseInt(digits.slice(0, 2), 16);
  const g = Number.parseInt(digits.slice(2, 4), 16);
  const b = Number.parseInt(digits.slice(4, 6), 16);
  return [Number.isFinite(r) ? r : 0, Number.isFinite(g) ? g : 0, Number.isFinite(b) ? b : 0];
}
