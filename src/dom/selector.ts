import type { SelectorStrategy, StableSelector } from '@/shared/changeset';

// Resilient selector resolution — never brittle nth-child chains, and shadow-DOM aware.
// See docs/idea/live-edit.md "Stable selectors" + plan 15 (complex sites). Pure + testable: pass a
// minimal element-like shape so it runs under jsdom and in unit tests.
//
// Shadow model (plan 15B): CSS `querySelector` cannot cross a shadow boundary, so a shadow-nested
// element is emitted as an ordered HOST-PATH — `hostSelector >>> innerSelector`, one `>>>` per crossed
// root — and re-selected by REPLAYING the path (root -> host -> host.shadowRoot -> …) via
// {@link resolveShadowSelector}. Open roots pierce; a closed root (`host.shadowRoot === null`) can't be
// pierced, so the path stops at the closed host — a coordinate/vision anchor — flagged `fragile`.

export interface ElementLike {
  getAttribute(name: string): string | null;
  readonly id: string;
  readonly tagName: string;
  readonly textContent: string | null;
  // Optional tree links. A real DOM Element supplies them; the minimal unit-test
  // fakes omit them, so the css-path generator degrades to a bare tag when absent.
  readonly parentElement?: ElementLike | null;
  readonly previousElementSibling?: ElementLike | null;
  // Shadow traversal (real Elements only). The minimal fakes omit it, so shadow host-path composition
  // is skipped for them — they model light DOM. Real values narrow to `ShadowRoot`/`Document` and drive
  // host-path building; nothing here queries or mutates.
  getRootNode?(options?: { composed?: boolean }): unknown;
}

const STABLE_DATA_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy'];

// Generated ids (hashed / framework) are not stable enough to ship.
//
// The hash test is ANCHORED to a whole `-`/`_` segment and needs a digit AND a letter (#165 F5).
// The former unanchored `[0-9a-f]{6,}` matched any six consecutive hex chars ANYWHERE, so ordinary
// hand-written ids were suppressed — `feedback` (f-e-e-d-b-a-c), `facade`, `decade`, `deface`,
// `effaced`, `accede`, and anything carrying a ≥6-digit number (`product-123456`). Suppressing a
// stable `#id` costs a fragile `#main > section:nth-of-type(4)` that names a DIFFERENT element as
// soon as the SPA renders one more sibling.
const FRAMEWORK_ID_PREFIX = /^(?:css-|sc-)/i;
const REACT_USE_ID = /:r[0-9a-z]+:/i;
// A whole segment of ≥6 hex chars mixing digits and letters — `a1b2c3`, an md5, a webpack hash.
// All-letters (`facade`) and all-digits (`123456`) are ordinary words/numbers, not hashes.
const HASH_SEGMENT = /^(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{6,}$/i;

function isGeneratedId(id: string): boolean {
  if (FRAMEWORK_ID_PREFIX.test(id) || REACT_USE_ID.test(id)) return true;
  return id.split(/[-_]/).some((segment) => HASH_SEGMENT.test(segment));
}

// A RECORD-KEY id — an id whose distinguishing part is a long run of digits: `49299222` (a Hacker
// News story id), `up_49299222`, `score_49299222`, `product-123456`. It is not GENERATED (so it is
// still the best handle for THIS page load, and #165 F5's rule that suppressing a working id costs
// a positional path still holds) — but it names one database row, so it will not exist on the next
// page load and a downstream dev-agent cannot map it to anything in source.
//
// The distinction from `isGeneratedId`: generated ids are suppressed as candidates; volatile ids
// are KEPT and flagged `fragile`. Threshold is a 4-digit run, which is past page-structure numbering
// (`col-2`, `step-3`, `h1`) and into identifier territory.
const DIGIT_RUN_SEGMENT = /^\d{4,}$/;

export function isVolatileId(id: string): boolean {
  return id.split(/[-_]/).some((segment) => DIGIT_RUN_SEGMENT.test(segment));
}

// Classes we never build a selector from: framework-generated (css-modules hash, styled/emotion,
// Svelte scope) and our own marker classes. Everything else is an author-written NAME — the single
// best source-mapping handle a class-free-id page still offers, and the candidate this engine was
// missing entirely (a class-bearing element fell straight through to an nth-of-type chain).
const GENERATED_CLASS = /^(?:css-|sc-|svelte-|emotion-|jsx-|_)|^[a-z]+_[A-Za-z0-9]{5,}$/;

function isGeneratedClass(name: string): boolean {
  if (GENERATED_CLASS.test(name)) return true;
  return name.split(/[-_]/).some((segment) => HASH_SEGMENT.test(segment));
}

// Tags that name a page REGION rather than a box. When one of these uniquely resolves it is a real
// structural anchor — `body`, `main`, `header` map to something a developer can find — so it is not
// flagged fragile. Any other uniquely-resolving bare tag is still emitted (a one-step selector beats
// a four-deep nth-of-type chain) but stays flagged: its uniqueness is incidental to this page state.
const LANDMARK_TAGS = new Set(['html', 'body', 'main', 'header', 'footer', 'nav', 'aside', 'form']);

// Separates two shadow-boundary segments in a `shadow`-strategy value. Always spaced, so it never
// collides with the css-path child combinator (` > `) nor with an unspaced `>>>` inside a quoted
// attribute value — `split`/`join` on this exact literal are round-trip safe.
export const SHADOW_COMBINATOR = ' >>> ';

function attr(el: ElementLike, name: string): string | null {
  const v = el.getAttribute(name);
  return v && v.trim() !== '' ? v : null;
}

/** How many of an element's classes become candidates. A utility-CSS page carries dozens; the
 *  first few author-written ones are the identifying ones and the rest are noise the model pays
 *  for on every step. */
const MAX_CLASS_CANDIDATES = 3;

/** The element's author-written class names (generated/hashed ones dropped), bounded. Reads the
 *  attribute rather than `classList` so it works on the minimal {@link ElementLike} fakes and on
 *  SVG elements (whose `className` is an `SVGAnimatedString`, not a string). */
function classNames(el: ElementLike): string[] {
  const raw = attr(el, 'class');
  if (!raw) return [];
  const names: string[] = [];
  for (const name of raw.split(/\s+/)) {
    if (name === '' || isGeneratedClass(name)) continue;
    names.push(name);
    if (names.length === MAX_CLASS_CANDIDATES) break;
  }
  return names;
}

/**
 * The ranked LOCAL selector candidates for `el` within its OWN root — most stable first: data-attr ->
 * id -> aria -> text -> css-path. Every `value` is a syntactically valid `querySelector` string (no
 * Playwright `:has-text()` pseudo) and never crosses a shadow boundary. Always returns at least one
 * candidate (the structural fallback). This is the shadow-agnostic core reused per boundary when
 * composing a host-path.
 */
function localCandidates(el: ElementLike, scope?: ParentNode): StableSelector[] {
  const candidates: StableSelector[] = [];
  const tag = el.tagName.toLowerCase();

  for (const name of STABLE_DATA_ATTRS) {
    const v = attr(el, name);
    if (v) candidates.push(make(`[${name}=${cssValue(v)}]`, 'data-attr'));
  }

  if (el.id && !isGeneratedId(el.id)) {
    // A record-key id (`#49299222`) still RESOLVES today, so it stays the ranked winner over a
    // positional chain — but it is flagged fragile: it names one database row and is gone on the
    // next page load. Flagging is the whole point; the changeset is supposed to map to SOURCE.
    candidates.push(make(`#${cssEscape(el.id)}`, 'id', isVolatileId(el.id)));
  }

  const role = attr(el, 'role');
  const label = attr(el, 'aria-label');
  if (role && label) {
    candidates.push(make(`${tag}[role=${cssValue(role)}][aria-label=${cssValue(label)}]`, 'aria'));
  }

  // Author-written class names — the rung the ladder was missing. On a legacy table page with no
  // data attributes and database-key ids (Hacker News), `table.itemlist` / `td.subtext` is the
  // ONLY thing in the markup a developer can grep for. Emitted `css-path` (the SelectorStrategy
  // enum lives in src/shared/changeset.ts and has no `class` member — see the report), non-fragile
  // only when `scope` proves it resolves to exactly this element.
  for (const cls of classNames(el)) {
    const value = `${tag}.${cssEscape(cls)}`;
    candidates.push(make(value, 'css-path', !anchors(scope, value, el)));
  }

  // A bare tag that uniquely resolves — `body`, `main`, the page's only `<form>`. One step beats
  // `html > body:nth-of-type(1)`, which is what this engine used to emit for `<body>`.
  if (scope && anchors(scope, tag, el)) {
    candidates.push(make(tag, 'css-path', !LANDMARK_TAGS.has(tag)));
  }

  // Structural fallback (always present, fragile). Text content can't be matched by
  // querySelector, so a text-bearing element keeps a bare-tag `text` candidate — the
  // heuristic the dev-agent uses to relocate the element by its visible text during
  // source-mapping. Without usable text it degrades to a scoped css-path that actually
  // re-selects the element.
  const text = el.textContent?.trim();
  candidates.push(
    text && text.length <= 50
      ? make(tag, 'text', true)
      : make(cssPath(el, scope), 'css-path', true),
  );

  return candidates;
}

/**
 * Resolve an element to an ordered list of stable selector *candidates*, most stable first. For a
 * light-DOM element this is {@link localCandidates} (data-attr -> id -> aria -> text -> css-path). For
 * an element nested in one or more shadow roots, every candidate is a HOST-PATH (`hostSelector >>>
 * innerSelector`) carrying the `shadow` strategy — the target's local candidates prefixed by the
 * heuristic best selector of each ancestor host, so the ranking (data-attr-in-shadow above
 * css-path-in-shadow) is preserved and {@link pickUnique} can verify each by replay.
 *
 * Pure — element-like in, candidates out. Reads only the element's own tree links (incl. `getRootNode`
 * for the host chain); never takes a `document` and never runs a query. The verified, uniqueness-checked
 * winner is {@link pickUnique}'s job. Always returns at least one candidate.
 */
export function resolveSelector(el: ElementLike): StableSelector[] {
  if (isElement(el)) {
    const hosts = hostChain(el, el.ownerDocument);
    if (hosts.length > 0) return shadowCandidates(el, hosts);
  }
  return localCandidates(el);
}

/**
 * Pick the single stable selector that resolves to *exactly* `el` within `doc`. For a light-DOM element,
 * walks {@link localCandidates}' ranked list and returns the first whose value selects this and only this
 * element (`hits.length === 1 && hits[0] === el`) — identity, not count. For a shadow-nested element it
 * composes + verifies a host-path (see {@link pickShadow}). When nothing uniquely resolves, degrades to
 * the scoped css-path flagged `fragile` rather than throwing. The one and only function that takes a `doc`.
 */
export function pickUnique(el: Element, doc: ParentNode): StableSelector {
  const hosts = hostChain(el, doc);
  if (hosts.length > 0) return pickShadow(el, hosts);

  for (const candidate of localCandidates(el, doc)) {
    if (resolvesToExactly(doc, candidate.value, el)) return candidate;
  }
  // Fallbacks, verified — NEVER return a value the ranked loop already proved ambiguous (#165 F6):
  // `queryOne` takes hits[0], so an ambiguous path silently mutates a DIFFERENT element while the
  // user watches. First the scoped path (its id anchor is uniqueness-checked, see cssPath), then
  // the full path from the root, which nth-of-type makes unique by construction.
  const path = cssPath(el, doc);
  if (resolvesToExactly(doc, path, el)) return make(path, 'css-path', true);
  const full = cssPath(el, doc, false);
  if (resolvesToExactly(doc, full, el)) return make(full, 'css-path', true);
  // Nothing resolves — `el` is detached from `doc` (the pre-removal selector `removeNode` records
  // by design). Emit the most descriptive value that still PARSES: every emitted value must be a
  // legal querySelector argument even when it matches nothing. A bare tag always parses.
  if (parsesAsSelector(doc, path)) return make(path, 'css-path', true);
  return make(el.tagName.toLowerCase(), 'css-path', true);
}

/**
 * Replay a `shadow`-strategy host-path against `root`, returning the element it selects (or `null`).
 * CSS can't cross a shadow boundary, so each ` >>> ` segment is resolved with `querySelector` in the
 * previous hop's *shadow root*: `root.querySelector(seg0)` -> `.shadowRoot.querySelector(seg1)` -> …
 * A single-segment value is a plain `querySelector`. A closed root (`shadowRoot === null`) stops the
 * walk and yields `null` — the caller then uses coordinates/vision on the last resolvable host. Also
 * the resolver a downstream consumer uses to turn any `shadow` selector back into a live element.
 */
export function resolveShadowSelector(root: ParentNode, value: string): Element | null {
  // XPath values arrive here too (the overlay highlight and the widget driver both replay stored
  // selectors through this function), and they are not host-paths — resolve them directly.
  if (isXPath(value)) return resolveXPath(root, value);
  const segments = value.split(SHADOW_COMBINATOR);
  let scope: ParentNode | null = root;
  let found: Element | null = null;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]?.trim();
    if (!scope || !seg) return null;
    let hit: Element | null;
    try {
      hit = scope.querySelector(seg);
    } catch {
      return null; // a segment this engine rejects never resolves
    }
    if (!hit) return null;
    found = hit;
    scope = i < segments.length - 1 ? hit.shadowRoot : null;
  }
  return found;
}

// --- shadow traversal -----------------------------------------------------

function isElement(node: ElementLike): node is ElementLike & Element {
  return typeof Element !== 'undefined' && node instanceof Element;
}

// The nearest root of `el`, narrowed to a shadow root — `null` for a light-DOM element (whose root is
// the Document) or an environment without Shadow DOM.
function shadowRootOf(el: Element): ShadowRoot | null {
  const root = el.getRootNode();
  return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root : null;
}

// The ordered shadow hosts between `el` and `stop` (the resolution scope), outermost first. Empty when
// `el` lives directly in `stop`'s tree — i.e., no shadow boundary is crossed relative to the scope, so
// resolution stays plain-CSS (the light-DOM path). `stop` clamps the climb so a scoped
// `pickUnique(el, shadowRoot)` never over-qualifies above its own root.
function hostChain(el: Element, stop: ParentNode): Element[] {
  const hosts: Element[] = [];
  let cur: Element = el;
  const seen = new Set<Element>();
  for (;;) {
    if (cur.getRootNode() === stop) break; // reached the resolution scope — stop climbing
    const root = shadowRootOf(cur);
    if (!root) break; // light DOM (root is a Document) — no more boundaries
    const host = root.host;
    if (seen.has(host)) break; // cycle guard (paranoia)
    seen.add(host);
    hosts.unshift(host);
    cur = host;
  }
  return hosts;
}

// Heuristic shadow candidates (ranked, may not be unique) for the ranked-alternates list. The verified,
// uniqueness-checked winner is `pickShadow`'s job. Each host contributes its single best local value as
// a fixed prefix; the target's own ranked locals become the varying tail.
function shadowCandidates(el: Element, hosts: Element[]): StableSelector[] {
  const prefix = hosts.map((h) => bestLocalValue(h)).join(SHADOW_COMBINATOR);
  const closed = hosts.some((h) => h.shadowRoot === null); // a closed crossing can't be pierced
  return localCandidates(el).map((c) =>
    make(`${prefix}${SHADOW_COMBINATOR}${c.value}`, 'shadow', c.fragile || closed),
  );
}

function bestLocalValue(el: Element): string {
  const [best] = localCandidates(el);
  return best?.value ?? el.tagName.toLowerCase();
}

// Compose + verify the winning host-path for a shadow-nested element. Each boundary (every host, then
// the target) is resolved to a selector unique WITHIN its own root; the segments join with ` >>> `. A
// closed root stops the walk at the closed host — the deepest resolvable target (a coordinate/vision
// anchor) — flagged `fragile`. Uniqueness-per-hop makes the composed path replay to exactly `el`.
function pickShadow(el: Element, hosts: Element[]): StableSelector {
  const chain: Element[] = [...hosts, el];
  const parts: string[] = [];
  let fragile = false;
  for (let i = 0; i < chain.length; i += 1) {
    const node = chain[i];
    if (!node) break;
    const scope: ParentNode | null =
      i === 0 ? ownerScopeOf(node) : (chain[i - 1]?.shadowRoot ?? null);
    if (!scope) {
      // The previous boundary is a CLOSED shadow root — unreachable from outside. Stop at the closed
      // host: the agent uses screenshot + click-at-point there instead of a DOM selector.
      fragile = true;
      break;
    }
    const local = pickLocal(node, scope);
    parts.push(local.value);
    if (local.fragile) fragile = true;
  }
  return make(parts.join(SHADOW_COMBINATOR), 'shadow', fragile);
}

// The ParentNode `el` is queried from — its own root node (a Document or an open ShadowRoot).
function ownerScopeOf(el: Element): ParentNode {
  return el.getRootNode() as ParentNode;
}

// The selector that resolves to exactly `el` WITHIN `scope` (never crossing a boundary): the first
// ranked local candidate that uniquely + identity-matches, else a fragile scoped css-path.
function pickLocal(el: Element, scope: ParentNode): StableSelector {
  for (const candidate of localCandidates(el, scope)) {
    if (resolvesToExactly(scope, candidate.value, el)) return candidate;
  }
  const path = cssPath(el, scope);
  return make(
    resolvesToExactly(scope, path, el) ? path : cssPath(el, scope, false),
    'css-path',
    true,
  );
}

function parsesAsSelector(doc: ParentNode, value: string): boolean {
  try {
    doc.querySelectorAll(value);
    return true;
  } catch {
    return false;
  }
}

function resolvesToExactly(doc: ParentNode, value: string, el: Element): boolean {
  let hits: NodeListOf<Element>;
  try {
    hits = doc.querySelectorAll(value);
  } catch {
    // A value that is not a valid selector for this document never counts as unique.
    return false;
  }
  // Identity, not count: `length === 1` alone accepts a different single element.
  return hits.length === 1 && hits[0] === el;
}

/**
 * Build a scoped `nth-of-type` css-path that uniquely re-selects `el` WITHIN its own root. Walks up the
 * ancestor chain emitting `tag:nth-of-type(n)` per level, anchoring at the nearest ancestor with a stable
 * id (`#id > ...`) for a shorter, more resilient scope, else up to the root (the top of a shadow tree, or
 * the document). Degrades to a bare tag when the element-like exposes no tree. Never crosses a shadow
 * boundary — {@link pickShadow} composes across boundaries by calling this per root.
 *
 * `scope`: when supplied, an ancestor id anchors the path only if it resolves UNIQUELY within scope
 * (#165 F6) — a legacy theme that renders `<div id="content">` twice would otherwise anchor at the
 * FIRST one and re-select an element in the wrong subtree. Without a scope the id is trusted, as before
 * (the pure {@link resolveSelector} path takes no document). `anchor: false` skips id anchoring entirely
 * and climbs to the root — the unambiguous-by-construction fallback.
 */
function cssPath(el: ElementLike, scope?: ParentNode, anchor = true): string {
  const segments: string[] = [];
  let cur: ElementLike | null | undefined = el;
  let isTarget = true;
  while (cur) {
    const tag = cur.tagName.toLowerCase();
    const stop = anchor && !isTarget ? anchorFor(cur, scope) : null;
    if (stop) {
      segments.unshift(stop);
      break;
    }
    const parent: ElementLike | null | undefined = cur.parentElement;
    segments.unshift(parent ? `${tag}:nth-of-type(${nthOfType(cur)})` : tag);
    cur = parent;
    isTarget = false;
  }
  return segments.join(' > ');
}

/**
 * Absolute XPath for `el` — `/html/body/div[2]/button[1]`. Unique by construction: every step is a
 * tag plus its 1-based index among same-tag siblings, so replaying it can only reach one node.
 *
 * Deliberately NOT one of {@link resolveSelector}'s candidates, and never {@link pickUnique}'s
 * answer: every value those emit must be a legal `querySelector` argument (asserted in
 * test/unit/selector.test.ts) because consumers pass them straight to the DOM, and an XPath is not
 * one. It travels as its own field on `element-picked` instead — an exact, positional handle for
 * naming what the user pointed at, alongside the CSS selector everything else uses. Tools accept
 * it as a target because {@link isXPath} routes it in `queryAll`.
 *
 * Pure and element-like: reads only `tagName`/`parentElement`, never queries a document.
 */
export function xpathFor(el: ElementLike): string {
  const steps: string[] = [];
  let cur: ElementLike | null | undefined = el;
  while (cur) {
    const tag = cur.tagName.toLowerCase();
    const parent: ElementLike | null | undefined = cur.parentElement;
    // No parent element = the document element; it needs no index (there is exactly one).
    steps.unshift(parent ? `${tag}[${nthOfType(cur)}]` : tag);
    cur = parent;
  }
  return `/${steps.join('/')}`;
}

/** Whether a selector VALUE is an XPath rather than CSS. A CSS selector can never begin with `/`,
 *  so the leading slash is an unambiguous discriminator — no extra field on the wire, and any
 *  stored selector stays a single string. */
export function isXPath(value: string): boolean {
  return value.startsWith('/');
}

/** Resolve an XPath against `root`'s document, or `null`. Wrapped because `document.evaluate` is
 *  absent in some hosts (and throws outright on a malformed expression), and a selector that can't
 *  resolve must degrade to "no match" exactly like a CSS miss. */
export function resolveXPath(root: ParentNode, value: string): Element | null {
  const doc = (root as Document).evaluate
    ? (root as Document)
    : ((root as Element).ownerDocument ?? null);
  if (!doc?.evaluate) return null;
  try {
    const result = doc.evaluate(value, doc, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null);
    const node = result.singleNodeValue;
    return node && node.nodeType === 1 ? (node as Element) : null;
  } catch {
    return null;
  }
}

/**
 * The selector an ANCESTOR contributes as a css-path anchor, or `null` when it offers none — the
 * climb then continues past it emitting another `nth-of-type` step.
 *
 * Ranked id -> class -> landmark tag. Extending this past `id` is what turns Hacker News'
 * `#hnmain > tbody:nth-of-type(1) > tr:nth-of-type(3) > td:nth-of-type(1) > table:nth-of-type(1) >
 * tbody:nth-of-type(1) > tr:nth-of-type(2) > td:nth-of-type(2)` into
 * `table.itemlist > tbody:nth-of-type(1) > tr:nth-of-type(2) > td:nth-of-type(2)`: a shallower path
 * hung off a NAME a developer can grep for, instead of eight positional steps from the page root.
 * Every anchor is uniqueness-checked within `scope` (#165 F6). Without a scope only the id anchors,
 * trusted as before (the pure {@link resolveSelector} path takes no document).
 */
function anchorFor(el: ElementLike, scope: ParentNode | undefined): string | null {
  if (el.id && !isGeneratedId(el.id)) {
    const value = `#${cssEscape(el.id)}`;
    if (!scope || anchors(scope, value, el)) return value;
  }
  if (!scope) return null;
  const tag = el.tagName.toLowerCase();
  for (const cls of classNames(el)) {
    const value = `${tag}.${cssEscape(cls)}`;
    if (anchors(scope, value, el)) return value;
  }
  return LANDMARK_TAGS.has(tag) && anchors(scope, tag, el) ? tag : null;
}

// Whether `value` selects `el` and nothing else within `scope`. Without a scope there is no
// document to ask, so the answer is "unproven" — `false` everywhere except the id anchor, which
// keeps its historical trust (see `anchorFor`) because the pure `resolveSelector` path has always
// worked that way and a suppressed id costs a positional path (#165 F5/F6).
function anchors(scope: ParentNode | undefined, value: string, el: ElementLike): boolean {
  if (!scope) return false;
  return resolvesToExactly(scope, value, el as unknown as Element);
}

function nthOfType(el: ElementLike): number {
  let n = 1;
  let sib: ElementLike | null | undefined = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === el.tagName) n += 1;
    sib = sib.previousElementSibling;
  }
  return n;
}

function make(value: string, strategy: SelectorStrategy, fragile = false): StableSelector {
  return { value, strategy, fragile };
}

function cssValue(v: string): string {
  // Escape the backslash FIRST (else escaping `"` would double-count the `\` it emits), then the
  // quote — otherwise a value containing `\` yields a broken/invalid attribute selector.
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Serialize a string as a CSS identifier (CSSOM "serialize an identifier").
//
// NOT delegated to the platform `CSS.escape`: that global is absent in jsdom, where
// every unit test here runs, and in the MV3 service worker. A naive `[^\w-]` escape
// is not enough either — a leading digit is legal in an HTML id (`id="2col"`) but
// illegal at the head of a CSS ident, so `#2col` throws in querySelector. Digits in
// that position must be hex-escaped (`\32 col`); the trailing space terminates the
// escape and is not a descendant combinator.
function cssEscape(v: string): string {
  const first = v.charCodeAt(0);
  let out = '';
  for (let i = 0; i < v.length; i += 1) {
    const c = v.charCodeAt(i);
    if (c === 0x00) {
      out += '�';
    } else if (
      (c >= 0x01 && c <= 0x1f) ||
      c === 0x7f ||
      (i === 0 && c >= 0x30 && c <= 0x39) ||
      (i === 1 && c >= 0x30 && c <= 0x39 && first === 0x2d)
    ) {
      out += `\\${c.toString(16)} `;
    } else if (i === 0 && c === 0x2d && v.length === 1) {
      out += `\\${v[i]}`;
    } else if (
      c >= 0x80 ||
      c === 0x2d ||
      c === 0x5f ||
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a)
    ) {
      out += v[i];
    } else {
      out += `\\${v[i]}`;
    }
  }
  return out;
}
