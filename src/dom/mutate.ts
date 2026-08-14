import { readComputed } from '@/dom/read';
import type { AttrChange, ClassChange, StyleChange } from '@/shared/changeset';
import type { MutationKind } from '@/shared/messages';

// Reversible mutation primitives — the content script's write half. Each primitive applies a
// change, captures enough prior state to reverse it EXACTLY, and returns the computed result for
// the model to reason over. Styles go through an injected stylesheet (never inline) so an edit is
// one droppable rule that wins the cascade; structural edits clipboard-track the moved/removed
// node for undo. Pure DOM (no chrome.*) → jsdom-testable. See docs/idea/live-edit.md.

const SHEET_ID = 'dz-designer-overrides';

export { SHEET_ID };

/** Our private per-element marker. setStyle tags a target with a generated id and writes
 *  `[data-dz-designer="dz-N"] { … }` into the overrides sheet, so an edit reverses to a precise
 *  rule even for anonymous elements. The recorder (slice 05) ignores this attribute. */
export const MARKER_ATTR = 'data-dz-designer';

/** Names an `injectCss` sheet so a re-injection REPLACES it instead of stacking another one. */
export const SHEET_ATTR = 'data-dz-designer-css';

/** Sheet ids are ours to constrain — the attribute selector that finds a sheet must not be
 *  escapable. Everything outside `[A-Za-z0-9_-]` is dropped rather than escaped: an id is a label,
 *  and a label that needs escaping is a label that is trying to be something else. */
function cssIdent(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned === '' ? 'default' : cleaned.slice(0, 64);
}

// Page-wide CSS is a WIDER grant than per-element `setStyle`, and this is where that widening is
// enforced. Two channels make raw CSS dangerous, and neither has any place in a design edit:
//
//   `@import`  — pulls a remote stylesheet into the page's own world. That is remote code loading
//                by any reasonable reading of the CLAUDE.md rule, and it is how a "just use this
//                font" instruction turns into a third-party request on the user's real session.
//   remote `url()` — the classic CSS exfiltration channel: a selector that matches only when some
//                attribute has a given value, paired with a background image, leaks that value to
//                whoever owns the host. Same-document `url(#fragment)` and inline `url(data:image/…)`
//                carry no request, so both stay allowed.
//
// Two dead-but-free additions: `expression()` (legacy IE) and `-moz-binding` / `behavior:` (XBL /
// HTC), each of which executed script from a stylesheet in its day.
//
// REFUSED, not stripped: silently rewriting a designer's stylesheet leaves them debugging CSS they
// did not write. The agent gets a message it can act on.
const CSS_AT_IMPORT = /@import\b/i;
const CSS_BINDING = /(?:-moz-binding|behavior)\s*:/i;
const CSS_EXPRESSION = /\bexpression\s*\(/i;
// `url(` up to its closing paren, quotes optional. Captured so the value can be classified.
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/** A human-readable reason page-wide CSS is refused, or `null` when it is safe to inject. */
export function cssDenyReason(css: string): string | null {
  if (CSS_AT_IMPORT.test(css)) {
    return 'Refused: @import loads a remote stylesheet into the page. Inline the rules instead, and use locally available fonts.';
  }
  if (CSS_BINDING.test(css)) {
    return 'Refused: `behavior` / `-moz-binding` attach executable bindings to a stylesheet.';
  }
  if (CSS_EXPRESSION.test(css)) {
    return 'Refused: `expression()` evaluates script from a stylesheet.';
  }
  CSS_URL.lastIndex = 0;
  for (const match of css.matchAll(CSS_URL)) {
    const value = (match[2] ?? '').trim();
    // Same rule the fragment sanitizer applies to SVG href: normalize away every char at or below
    // U+0020 first, because the URL parser ignores them and `ht\ttps:` still fetches.
    const normalized = Array.from(value, (c) => (c.charCodeAt(0) > 0x20 ? c : ''))
      .join('')
      .toLowerCase();
    if (normalized === '' || normalized.startsWith('#') || normalized.startsWith('data:image/')) {
      continue;
    }
    return `Refused: url(${value}) would load a remote resource from the page. Only same-document url(#id) and inline data:image/ are allowed.`;
  }
  return null;
}

export interface Reversible {
  /** Restore the exact prior state. Called LIFO with the recorder's undo log. */
  undo(): void;
}

// An element-targeting mutation: it contributes a recorder `MutationEvent` (kind + before/after
// serialized state, messages.ts). `computed` is the post-change value the model reads back.
// The optional typed fields (#9) are the GROUND-TRUTH mechanical delta, captured here at
// mutation time where the prior values still exist — the recorder folds them onto the event so
// the SW's durable Edit doesn't depend on the model restating its own tool calls.
export interface ElementMutation<C = unknown> extends Reversible {
  kind: MutationKind;
  computed: C;
  before: string;
  after: string;
  /** The overrides-sheet rule id (the element marker) for a `setStyle`, so undo can drop it. */
  ruleId?: string;
  /** setStyle: one entry per prop the call touched — `before` is the PRE-mutation computed
   *  value (null when the prop had no computed value), `after` the POST-mutation readback. */
  styleChanges?: StyleChange[];
  /** setAttr: the single attribute delta (`before: null` = the attribute was absent). */
  attrChange?: AttrChange;
  /** addClass/removeClass: the single class delta — present ONLY when the op actually changed
   *  the class list (a no-op add/remove emits nothing, so the SW's class-fold window diff never
   *  has to cancel a phantom op back out). */
  classChange?: ClassChange;
  /** setText: the text delta; `before` is the prior textContent bounded to
   *  {@link TEXT_CHANGE_BEFORE_CAP} chars (the legacy opaque `before` keeps full innerHTML). */
  textChange?: { before: string; after: string };
}

// A page-level op (injectCss / setViewport): no single element target, so it is NOT a
// MutationEvent (messages.ts `MutationKind`). Still fully reversible.
export interface PageMutation<C = unknown> extends Reversible {
  computed: C;
}

export interface Mutator {
  setStyle(el: Element, props: Record<string, string>): ElementMutation<Record<string, string>>;
  setText(el: Element, value: string): ElementMutation<string>;
  setAttr(el: Element, name: string, value: string): ElementMutation<string>;
  removeAttr(el: Element, name: string): ElementMutation<string | null>;
  addClass(el: Element, name: string): ElementMutation<string>;
  removeClass(el: Element, name: string): ElementMutation<string>;
  insertNode(
    ref: Element,
    html: string,
    position?: InsertPosition,
  ): ElementMutation<{ html: string }>;
  moveNode(
    el: Element,
    ref: Element,
    position?: InsertPosition,
  ): ElementMutation<{ moved: boolean }>;
  removeNode(el: Element): ElementMutation<{ removed: boolean }>;
  wrapNode(
    target: Element,
    html: string,
    endTarget?: Element,
  ): ElementMutation<{ html: string; wrapped: number }>;
  unwrapNode(el: Element): ElementMutation<{ unwrapped: number }>;
  replaceSubtree(el: Element, html: string): ElementMutation<{ html: string }>;
  injectCss(
    css: string,
    id?: string,
  ): PageMutation<{ bytes: number; id: string; replaced: boolean }>;
  setViewport(size: { width: number; height?: number }): PageMutation<{
    width: number;
    height: number | null;
  }>;
}

// camelCase or kebab CSS prop -> kebab (what the injected rule + getComputedStyle both expect).
// A prop already containing `-` (kebab, or a `--custom-prop`) passes through untouched.
function toKebab(prop: string): string {
  return prop.includes('-') ? prop : prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

// className is an SVGAnimatedString (not a string) on SVG elements, so read the attribute.
function classAttr(el: Element): string {
  return el.getAttribute('class') ?? '';
}

/** Cap on `textChange.before` (#9): the prior textContent can be arbitrarily long (a whole
 *  article body), but the event rides the bus and lands in the changeset — 2000 chars is ample
 *  to identify the replaced copy. The undo path never reads this field (it uses the lossless
 *  legacy `before` innerHTML), so truncation is safe. */
export const TEXT_CHANGE_BEFORE_CAP = 2000;

function insertAt(ref: Element, node: Node, position: InsertPosition): void {
  const parent = ref.parentNode;
  switch (position) {
    case 'beforebegin':
      parent?.insertBefore(node, ref);
      break;
    case 'afterbegin':
      ref.insertBefore(node, ref.firstChild);
      break;
    case 'afterend':
      parent?.insertBefore(node, ref.nextSibling);
      break;
    default: // 'beforeend'
      ref.appendChild(node);
  }
}

// Parse `html` into its ordered top-level nodes. Uses a <template> whose content is inert (no scripts
// run, no remote code fetched WHILE parsed), then imports the WHOLE fragment — every element AND text
// node — into the live document, so multi-node and bare-text markup round-trips instead of collapsing
// to the first element or getting wrapped in a span. The fragment is sanitized first
// (sanitizeFragment): no executable/framed/remote-load content survives insertion.
function nodesFromHtml(doc: Document, html: string): Node[] {
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  sanitizeFragment(tpl.content);
  const frag = doc.importNode(tpl.content, true);
  return Array.from(frag.childNodes);
}

// Tags dropped outright from inserted markup: framed-document carriers (iframe/object/embed),
// document-hijack tags (base rewrites every relative URL; meta refresh navigates; link pulls remote
// CSS; a <style> block is a page-WIDE stylesheet — beyond setStyle's per-element scoped grant and a
// selector+url() exfil channel), script (already inert via the template-parse "already started"
// flag, dropped for zero ambiguity), and SMIL animation tags (animate/set/animateMotion/
// animateTransform can rewrite a navigational attribute to a javascript: URL AFTER insertion — the
// attr pass below can't see a future mutation). None has a legitimate use in an agent design edit —
// mockups are built from layout, text, and styled elements.
const DROPPED_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'base',
  'meta',
  'link',
  'style',
  // SMIL — both casings: type selectors match HTML elements case-insensitively but SVG
  // elements (animateMotion/animateTransform are camelCase) case-sensitively.
  'animate',
  'set',
  'animateMotion',
  'animateTransform',
  'animatemotion',
  'animatetransform',
]);

// Sanitize one parsed fragment before insertion (CSP-safe by construction):
// - drop every DROPPED_TAGS element outright,
// - run EVERY attribute of every remaining element through the same `attrDenyReason` policy
//   setAttr uses (on* handlers, remote-load attrs, javascript: URLs, our overrides marker) and
//   strip the refused ones — otherwise insertNode would trivially bypass setAttr's deny-list
//   (e.g. `setAttr('srcdoc', …)` is refused, so `<iframe srcdoc=…>` must die too),
// - recurse into nested <template> content (querySelectorAll does not descend into it, but page
//   JS can clone it live later).
// Note: this refuses plain remote loads (<img src>) exactly like setAttr already does — the
// agent composes mockups from markup it can describe, not hotlinked assets.
function sanitizeFragment(frag: DocumentFragment): void {
  for (const el of frag.querySelectorAll(DROPPED_TAGS_SELECT)) el.remove();
  for (const el of frag.querySelectorAll('*')) {
    for (const name of el.getAttributeNames()) {
      if (attrDenyReason(name, el.getAttribute(name) ?? '') !== null) el.removeAttribute(name);
    }
    // SVG image/use/feImage load their target via href/xlink:href (not src) — automatic
    // remote-load channels the name-based deny-list misses. ALLOWLIST on the normalized value
    // (every char ≤ U+0020 stripped, mirroring attrDenyReason's scheme probe — the URL parser
    // ignores those chars, so C0/tab-obfuscated and protocol-relative URLs must die too): keep
    // only same-document #fragment refs and inline data:image/ — every other value is refused.
    const tag = el.tagName.toLowerCase();
    if (tag === 'image' || tag === 'use' || tag === 'feimage') {
      for (const name of ['href', 'xlink:href']) {
        const value = el.getAttribute(name);
        if (value === null) continue;
        const normalized = Array.from(value, (c) => (c.charCodeAt(0) > 0x20 ? c : ''))
          .join('')
          .toLowerCase();
        if (!normalized.startsWith('#') && !normalized.startsWith('data:image/'))
          el.removeAttribute(name);
      }
    }
    const tpl = el instanceof HTMLTemplateElement ? el : null;
    if (tpl) sanitizeFragment(tpl.content);
    // Defense-in-depth: declarative shadow DOM — if a nested template attached a shadow root
    // during parsing, querySelectorAll can't cross into it, so sanitize its content too.
    // (Verified 2026-07-23 in real Chrome-for-Testing: DSD does NOT attach inside
    // template.content and importNode does not clone a shadow root, so the channel is not live —
    // the recursion is cheap insurance against engine drift. ShadowRoot extends DocumentFragment.)
    if (el.shadowRoot) sanitizeFragment(el.shadowRoot);
  }
}

const DROPPED_TAGS_SELECT = [...DROPPED_TAGS].join(',');

/** Cap on how many sibling nodes one `wrapNode` may absorb. A range is one parent's children, so
 *  this is generous (a 30-story list is ~60 nodes counting whitespace); it exists so a selector
 *  mistake cannot move an entire document into one wrapper in a single un-reviewable step. */
export const MAX_WRAP_RANGE = 500;

/**
 * The ordered node run from `target` to `endTarget` INCLUSIVE — every child node, not just the
 * elements. Whitespace and text between the elements travel with the range, because a range that
 * leaves its own whitespace behind is not the range the caller pointed at.
 *
 * Throws when the two are not siblings or `endTarget` precedes `target`: a silent reinterpretation
 * of a bad range would move the wrong markup while the user watches.
 */
function siblingRange(target: Element, endTarget: Element): Node[] {
  if (target.parentNode === null) throw new Error('Cannot wrap a detached element.');
  if (endTarget.parentNode !== target.parentNode) {
    throw new Error('wrapNode: the range start and end must be siblings (same parent element).');
  }
  const nodes: Node[] = [];
  let cur: Node | null = target;
  while (cur) {
    nodes.push(cur);
    if (cur === endTarget) return nodes;
    if (nodes.length > MAX_WRAP_RANGE) {
      throw new Error(`wrapNode: range exceeds ${MAX_WRAP_RANGE} nodes; narrow it.`);
    }
    cur = cur.nextSibling;
  }
  throw new Error('wrapNode: the range end comes before the range start in document order.');
}

/**
 * The single wrapper ELEMENT `html` describes, after sanitization. Whitespace-only text at the top
 * level is tolerated (authored markup is usually indented) and dropped; anything else is refused,
 * because "wrap these in two containers" has no meaning and picking one silently would be a guess.
 */
function singleWrapper(doc: Document, html: string): Element {
  const nodes = nodesFromHtml(doc, html).filter(
    (n) => n.nodeType === 1 || (n.textContent ?? '').trim() !== '',
  );
  const [first] = nodes;
  if (nodes.length !== 1 || !(first instanceof Element)) {
    throw new Error(
      'wrapNode: `html` must describe exactly one wrapper element (e.g. `<section class="stories"></section>`).',
    );
  }
  return first;
}

/**
 * Where the wrapped nodes go inside the wrapper: its DEEPEST SINGLE element — so
 * `<section class="stories"><ul></ul></section>` puts the wrapped rows inside the `<ul>`, which is
 * what the author of that markup meant. The descent stops the moment a level is ambiguous (more
 * than one child element, or text content of its own), because past that point there is no single
 * obviously-intended slot and guessing would silently bury content.
 */
function wrapperSlot(wrapper: Element): Element {
  let slot = wrapper;
  for (;;) {
    const onlyChild = slot.children.length === 1 ? slot.children[0] : null;
    const ownText = Array.from(slot.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '',
    );
    if (!onlyChild || ownText) return slot;
    slot = onlyChild;
  }
}

/**
 * Whether a restore can safely proceed: the original parent is still in the document and the
 * anchor it will insert before is still that parent's child.
 *
 * The same churn honesty `moveNode`/`removeNode` already apply. A blind `insertBefore` either
 * throws `NotFoundError` or — worse, when the anchor sits inside a DETACHED parent — "succeeds"
 * into an invisible tree and looks like a real revert.
 */
function anchorIntact(parent: Node, anchor: Node | null): boolean {
  return parent.isConnected && (anchor === null || anchor.parentNode === parent);
}

function serialize(node: Node): string {
  return node instanceof Element ? node.outerHTML : (node.textContent ?? '');
}

// Attribute names refused outright: each loads a remote resource, injects/executes a framed
// document, or exfiltrates — none has a legitimate use in an agent design edit. `srcdoc` and
// `<object data="…text/html">` in particular execute script in a (nested) browsing context, which
// setStyle's url() cannot. Includes our private setStyle marker so an agent can't corrupt the
// overrides map. (`src` on iframe/img, `srcset`, `poster`, `ping`, `data` on object/embed, and the
// legacy presentational `background` — mapped to background-image by the HTML rendering rules on
// body/table family elements, i.e. an automatic remote load.)
const DENIED_ATTR_NAMES = new Set([
  'src',
  'srcset',
  'poster',
  'ping',
  'data',
  'srcdoc',
  'background',
  MARKER_ATTR,
]);

// The only attribute names where a `javascript:` value EXECUTES on activation/submit. The scheme is
// inert text everywhere else, so probing e.g. `alt`/`title` would only false-refuse legit copy
// ("JavaScript: The Good Parts"). `src`/`data` (the other executable-URL attrs) are denied by name.
const URL_NAV_ATTRS = new Set(['href', 'xlink:href', 'formaction', 'action']);

// Security deny-list for `setAttr`: returns a human-readable reason a raw attribute write is
// refused, or null when it is safe. A bare `setAttribute` is a way to smuggle executable code or a
// remote load past our no-remote-code / CSP posture (docs/architecture/mv3-worlds.md), so the known
// vectors are gated at the source (matching the on*-stripping insertNode already does). This is NOT
// an exhaustive XSS filter — it blocks inline event handlers (`on*`), the remote-load / framed-script
// attribute names above, and a `javascript:` URL in a navigational attribute. Not covered
// (accept-with-follow-up if it ever matters): `data:` navigations, `style` url() loads.
export function attrDenyReason(name: string, value: string): string | null {
  const attr = name.trim().toLowerCase();
  if (attr.startsWith('on')) {
    return `Refused: "${name}" is an inline event handler; on* attributes run page JS.`;
  }
  if (attr === MARKER_ATTR) {
    return `Refused: "${name}" is reserved for the editor's internal style overrides.`;
  }
  if (DENIED_ATTR_NAMES.has(attr)) {
    return `Refused: "${name}" can load a remote resource or inject/execute markup; it is not editable.`;
  }
  if (URL_NAV_ATTRS.has(attr)) {
    // Drop every char at or below U+0020 (space + all C0 control chars) before probing the scheme:
    // the URL parser ignores them, so "java\tscript:", " javascript:", and leading NULs all still
    // execute. A char-code filter avoids a control-char regex (noControlCharactersInRegex).
    const scheme = Array.from(value, (c) => (c.charCodeAt(0) > 0x20 ? c : ''))
      .join('')
      .toLowerCase();
    if (scheme.startsWith('javascript:')) {
      return `Refused: "${name}" has a javascript: URL, which executes on activation.`;
    }
  }
  return null;
}

/** A tree that can host an overrides sheet: the page document, or a shadow root (whose elements
 *  document CSS never reaches — see `rootOf`). */
type SheetRoot = Document | ShadowRoot;

/** One element's live overrides + the root whose sheet carries them. */
interface OverrideEntry {
  root: SheetRoot;
  /** kebab prop -> value; the source of truth the sheet is rebuilt from. */
  props: Map<string, string>;
}

/**
 * A page-bound reversible mutator. Holds the injected overrides stylesheet + per-element override
 * maps so repeated `setStyle`s on one element merge into a single rule and unwind precisely. One
 * instance per page (the content script owns it); pass a jsdom `document` in tests.
 */
export function createMutator(doc: Document = document): Mutator {
  let markerSeq = 0;
  // marker id -> its current overrides + host root; the source of truth the sheet is built from.
  const overrides = new Map<string, OverrideEntry>();
  // Every root we have ever rendered into, so a render can CLEAR a sheet whose last override was
  // just undone (a root with no entries left never comes up in the overrides walk).
  const sheets = new Map<SheetRoot, HTMLStyleElement>();

  // Document rules do not cross a shadow boundary, so a shadow-nested target needs its rule in
  // THAT root's own sheet (#165 F4 — the picker resolves shadow-nested elements now, so setStyle
  // has to be able to reach them). A detached element falls back to the page document.
  function rootOf(el: Element): SheetRoot {
    const root = el.getRootNode();
    return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root : doc;
  }

  function ensureSheet(root: SheetRoot): HTMLStyleElement {
    const existing = root.getElementById(SHEET_ID);
    if (existing instanceof HTMLStyleElement) {
      sheets.set(root, existing);
      return existing;
    }
    const style = doc.createElement('style');
    style.id = SHEET_ID;
    const host = root instanceof Document ? (root.head ?? root.documentElement) : root;
    host.appendChild(style);
    sheets.set(root, style);
    return style;
  }

  // Rebuild every overrides sheet from `overrides` THROUGH CSSOM — never by string-concatenating a
  // rule body (#165 F1). `insertRule` fixes the rule's boundaries and `setProperty` writes one
  // declaration inside it, so a value carrying `}` (or any other CSS syntax) cannot close our rule
  // and append page-wide CSS — the parser simply drops a declaration it can't parse. This is the
  // same threat the sanitizer's DROPPED_TAGS entry for <style> names: a page-WIDE stylesheet is a
  // repaint-anything + selector/url() exfil channel, beyond setStyle's per-element grant.
  function renderSheet(): void {
    for (const entry of overrides.values()) if (entry.props.size > 0) ensureSheet(entry.root);
    for (const style of sheets.values()) {
      const sheet = style.sheet;
      if (!sheet) continue;
      while (sheet.cssRules.length > 0) sheet.deleteRule(0);
    }
    for (const [id, entry] of overrides) {
      if (entry.props.size === 0) continue;
      const sheet = sheets.get(entry.root)?.sheet;
      if (!sheet) continue; // an unattached sheet has no CSSOM; nothing to render into
      const index = sheet.insertRule(`[${MARKER_ATTR}="${id}"] {}`, sheet.cssRules.length);
      const rule = sheet.cssRules[index];
      if (!(rule instanceof CSSStyleRule)) continue;
      for (const [prop, value] of entry.props) rule.style.setProperty(prop, value, 'important');
    }
  }

  function markerOf(el: Element): string {
    const current = el.getAttribute(MARKER_ATTR);
    if (current) return current;
    markerSeq += 1;
    const id = `dz-${markerSeq}`;
    el.setAttribute(MARKER_ATTR, id);
    return id;
  }

  function setStyle(
    el: Element,
    props: Record<string, string>,
  ): ElementMutation<Record<string, string>> {
    const id = markerOf(el);
    const entry = overrides.get(id) ?? { root: rootOf(el), props: new Map<string, string>() };
    const map = entry.props;
    overrides.set(id, entry);

    const entries = Object.entries(props).map(([prop, value]) => [toKebab(prop), value] as const);
    const touchedProps = entries.map(([prop]) => prop);
    // #9 ground truth: the page's PRE-mutation computed value per touched prop, read BEFORE the
    // sheet re-render (so it reflects prior overrides + page CSS, NOT this call's values — and
    // never the override-map prior, which only knows our own edits). No fallback: an empty
    // computed value is the honest pre-state, recorded as null.
    const preComputed = readComputed(el, touchedProps);
    // Prior value per touched prop; `undefined` = the prop was not previously overridden.
    const prior = new Map<string, string | undefined>(
      entries.map(([prop]) => [prop, map.get(prop)]),
    );
    const before = JSON.stringify(
      Object.fromEntries(entries.map(([prop]) => [prop, map.get(prop) ?? ''])),
    );

    for (const [prop, value] of entries) map.set(prop, value);
    renderSheet();

    const fallback = Object.fromEntries(entries);
    // The model-facing ToolResult readback KEEPS the raw-input fallback (pre-existing: a
    // not-yet-cascaded rule should still report the value the model just set).
    const computed = readComputed(el, touchedProps, fallback);
    // Ground truth must NOT: an invalid declaration is dropped by the CSS parser, and the
    // fallback would stamp the UNAPPLIED raw value into styleChanges as if it took. Read back
    // fallback-free and drop any pair whose after is empty (the declaration didn't take). A
    // prop with a non-empty UA default (color, gap→normal) instead records that default — the
    // honest current value, never the raw input.
    const applied = readComputed(el, touchedProps);
    const styleChanges: StyleChange[] = [];
    for (const [prop] of entries) {
      const after = applied[prop];
      if (!after) continue;
      styleChanges.push({ prop, before: preComputed[prop] ?? null, after });
    }
    return {
      kind: 'setStyle',
      ruleId: id,
      before,
      after: JSON.stringify(fallback),
      computed,
      styleChanges,
      undo() {
        const map = overrides.get(id)?.props;
        if (!map) return;
        for (const [prop, value] of prior) {
          if (value === undefined) map.delete(prop);
          else map.set(prop, value);
        }
        // Marker is our private attribute; with no overrides left it is always safe to drop.
        if (map.size === 0) {
          overrides.delete(id);
          el.removeAttribute(MARKER_ATTR);
        }
        renderSheet();
      },
    };
  }

  function setText(el: Element, value: string): ElementMutation<string> {
    // Capture the element's full markup (innerHTML), not the flattened textContent: an element with
    // child nodes must round-trip its structure on undo, and the recorded before-state stays lossless.
    const before = el.innerHTML;
    // #9: the typed delta carries the flattened TEXT (what the model sees as changing), bounded —
    // the lossless innerHTML above stays the undo/record state.
    const textBefore = (el.textContent ?? '').slice(0, TEXT_CHANGE_BEFORE_CAP);
    el.textContent = value;
    return {
      kind: 'setText',
      computed: value,
      before,
      after: value,
      textChange: { before: textBefore, after: value },
      undo() {
        el.innerHTML = before;
      },
    };
  }

  function setAttr(el: Element, name: string, value: string): ElementMutation<string> {
    // Safe at the source: refuse a denied write even for a direct caller that skips the executor's
    // pre-check. The executor (execute.ts) checks first so the agent gets a clean error ToolResult
    // rather than this throw.
    const denied = attrDenyReason(name, value);
    if (denied) throw new Error(denied);
    const prev = el.getAttribute(name); // string | null — null means the attribute was absent
    el.setAttribute(name, value);
    return {
      kind: 'setAttr',
      computed: value,
      // Self-describing like setStyle: encode the attribute NAME into before/after so the event is
      // recoverable downstream (#9 recorder / #10 fold). Bare values alone would lose WHICH attribute
      // changed — unlike class toggles (full class string) or setStyle (`{prop: value}`), a raw
      // setAttr value is not enough to reconstruct the edit. `null` = the attribute was absent.
      before: JSON.stringify({ [name]: prev }),
      after: JSON.stringify({ [name]: value }),
      // #9: the same delta in typed form — the durable Edit.attrs[] entry needs no JSON.parse.
      attrChange: { name, before: prev, after: value },
      undo() {
        if (prev !== null) el.setAttribute(name, prev);
        else el.removeAttribute(name);
      },
    };
  }

  /**
   * Remove an attribute — the missing counterpart to {@link setAttr}. `AttrChange.after` is
   * declared nullable in src/shared/changeset.ts precisely to mean "the attribute was removed",
   * and until now NO producer could emit that: the agent could set `hidden`, `disabled`,
   * `aria-hidden`, `colspan`, `width` but never take one away, so half the legacy-markup design
   * moves (drop a presentational `width="85%"`, drop an `align`, un-hide a node) were unreachable.
   *
   * Reuses `kind: 'setAttr'` with `attrChange.after = null` rather than inventing a kind — that is
   * the exact shape the durable Edit already models, so the fold and the report need no change.
   * Removing an attribute that is already absent is a no-op: it emits no `attrChange` (same
   * real-delta rule as add/removeClass) so the fold never has to cancel a phantom back out.
   */
  function removeAttr(el: Element, name: string): ElementMutation<string | null> {
    // The marker is our private overrides handle; dropping it orphans the element's rule in the
    // sheet while `overrides` still holds it. Same refusal as setAttr's, from the same policy.
    if (name.trim().toLowerCase() === MARKER_ATTR) {
      throw new Error(`Refused: "${name}" is reserved for the editor's internal style overrides.`);
    }
    const prev = el.getAttribute(name); // null = already absent, so there is nothing to record
    if (prev !== null) el.removeAttribute(name);
    return {
      kind: 'setAttr',
      computed: null,
      before: JSON.stringify({ [name]: prev }),
      after: JSON.stringify({ [name]: null }),
      ...(prev !== null ? { attrChange: { name, before: prev, after: null } } : {}),
      undo() {
        if (prev !== null) el.setAttribute(name, prev);
      },
    };
  }

  function addClass(el: Element, name: string): ElementMutation<string> {
    const before = classAttr(el);
    const added = !el.classList.contains(name); // undo must not strip a pre-existing class
    if (added) el.classList.add(name);
    const after = classAttr(el);
    return {
      kind: 'addClass',
      computed: after,
      before,
      after,
      // #9 ground truth ONLY on a real delta: a no-op add (the class was already present)
      // changed nothing, so it must not emit an op the fold would have to cancel back out
      // (the SW's class merge is a window set-diff over the events' classAttr strings).
      ...(added ? { classChange: { name, op: 'add' as const } } : {}),
      undo() {
        if (added) el.classList.remove(name);
      },
    };
  }

  function removeClass(el: Element, name: string): ElementMutation<string> {
    const before = classAttr(el);
    const removed = el.classList.contains(name); // undo must not add a class that was never there
    if (removed) el.classList.remove(name);
    const after = classAttr(el);
    return {
      kind: 'removeClass',
      computed: after,
      before,
      after,
      // Same real-delta rule as addClass: a no-op remove (the class was absent) emits nothing.
      ...(removed ? { classChange: { name, op: 'remove' as const } } : {}),
      undo() {
        if (removed) el.classList.add(name);
      },
    };
  }

  function insertNode(
    ref: Element,
    html: string,
    position: InsertPosition = 'beforeend',
  ): ElementMutation<{ html: string }> {
    // Keep a ref to EVERY inserted top-level node (a fragment can carry several elements + text
    // nodes) so undo removes the whole set and `after` serializes all of it, not just the first.
    const nodes = nodesFromHtml(doc, html);
    const frag = doc.createDocumentFragment();
    for (const node of nodes) frag.appendChild(node);
    insertAt(ref, frag, position);
    const after = nodes.map(serialize).join('');
    return {
      kind: 'insertNode',
      computed: { html: after },
      before: '',
      after,
      undo() {
        for (const node of nodes) node.parentNode?.removeChild(node);
      },
    };
  }

  function moveNode(
    el: Element,
    ref: Element,
    position: InsertPosition = 'beforeend',
  ): ElementMutation<{ moved: boolean }> {
    const parent = el.parentNode;
    const next = el.nextSibling;
    insertAt(ref, el, position);
    return {
      kind: 'moveNode',
      computed: { moved: true },
      before: '',
      after: '',
      undo() {
        // Anchor validation: page-side churn between apply and undo (an SPA re-render is the norm
        // on target pages) may have removed/relocated the anchor or the whole parent. A blind
        // insertBefore would either throw NotFoundError or — worse, when `next` still sits inside
        // a DETACHED parent — "succeed" into an invisible tree and look like a real revert.
        if (!parent) {
          // The element was detached at apply time (executor never produces this; direct calls
          // can): "restore" = remove it from wherever it was moved to.
          el.remove();
          return;
        }
        if (!parent.isConnected || (next && next.parentNode !== parent))
          throw new Error(
            'Cannot undo moveNode: the original location changed since the mutation (page updated).',
          );
        parent.insertBefore(el, next);
      },
    };
  }

  function removeNode(el: Element): ElementMutation<{ removed: boolean }> {
    const parent = el.parentNode;
    const next = el.nextSibling;
    const before = serialize(el);
    parent?.removeChild(el);
    return {
      kind: 'removeNode',
      computed: { removed: true },
      before,
      after: '',
      undo() {
        // Same churn honesty as moveNode's undo (see above).
        if (!parent) return;
        if (!parent.isConnected || (next && next.parentNode !== parent))
          throw new Error(
            'Cannot undo removeNode: the original location changed since the mutation (page updated).',
          );
        parent.insertBefore(el, next);
      },
    };
  }

  /**
   * Inject (or REPLACE) one page-wide stylesheet — the primitive a full-page overhaul is written
   * in. Where {@link setStyle} pins one rule per element behind a generated marker attribute,
   * this writes CSS the way a developer writes it: real selectors, custom properties on `:root`,
   * media queries. That is also what makes it shippable — the changeset carries a stylesheet a
   * reviewer can read, instead of a pile of computed-value diffs keyed to nth-of-type chains.
   *
   * `id` NAMES the sheet, and a second call with the same id REPLACES its text rather than
   * stacking another `<style>` on top. An overhaul is iterative; ten accumulated sheets with
   * escalating specificity is a trap, and it makes "what is the current design?" unanswerable.
   * Undo restores the previous text for that id, or removes the element when there was none.
   *
   * The CSS is policy-checked first ({@link cssDenyReason}) and REFUSED, never silently stripped:
   * a designer's stylesheet quietly altered under them is worse than an error they can read.
   */
  /**
   * Wrap an element — or a RANGE of consecutive siblings — in one agent-authored container. The
   * overhaul move: a legacy `<table>` row group becomes `<section class="stories">…</section>`,
   * a run of `<div>`s becomes a `<ul>`, a bare heading and its paragraph become an `<article>`.
   *
   * ONE mutation, not an insert composed with a move. Composing them is what gets the range case
   * wrong: the second op is written against anchors the first op just changed, and the two undo
   * entries unwind independently, so a single `undo` leaves a half-built wrapper on the page.
   * Here the wrapper goes in at the range's exact position and the whole run moves into it under
   * one `undo()` that restores the EXACT prior sibling order — the nodes are re-inserted in their
   * original sequence before the anchor that followed the range, never appended and hoped for.
   *
   * The children land in the wrapper's DEEPEST SINGLE element, so
   * `<section class="stories"><ul></ul></section>` puts them inside the `<ul>` — see
   * {@link wrapperSlot}, which stops descending the moment a level is ambiguous.
   */
  function wrapNode(
    target: Element,
    html: string,
    endTarget?: Element,
  ): ElementMutation<{ html: string; wrapped: number }> {
    const parent = target.parentNode;
    if (!parent) throw new Error('Cannot wrap a detached element.');
    const nodes = endTarget ? siblingRange(target, endTarget) : [target];
    // Captured BEFORE anything moves: the node that followed the range is where undo puts it back.
    const anchor = nodes[nodes.length - 1]?.nextSibling ?? null;
    const before = nodes.map(serialize).join('');

    const wrapper = singleWrapper(doc, html);
    const slot = wrapperSlot(wrapper);
    parent.insertBefore(wrapper, target);
    for (const node of nodes) slot.appendChild(node);

    const after = wrapper.outerHTML;
    const count = nodes.filter((n) => n.nodeType === 1).length;
    return {
      kind: 'wrapNode',
      computed: { html: after, wrapped: count },
      before,
      after,
      undo() {
        if (!anchorIntact(parent, anchor)) {
          throw new Error(
            'Cannot undo wrapNode: the original location changed since the mutation (page updated).',
          );
        }
        // Original sequence, restored before the original anchor — order is reconstructed, not
        // approximated. Then the (now empty) wrapper goes.
        for (const node of nodes) parent.insertBefore(node, anchor);
        wrapper.remove();
      },
    };
  }

  /**
   * Drop a wrapper and leave its children exactly where they were — the inverse of
   * {@link wrapNode}, and the primitive that dismantles legacy nesting (the `<div>` inside a
   * `<div>` inside a `<center>` that three redesigns left behind).
   *
   * Node identity is retained for every child AND for the wrapper itself, so undo restores
   * listeners and state, not a re-parsed copy.
   */
  function unwrapNode(el: Element): ElementMutation<{ unwrapped: number }> {
    const parent = el.parentNode;
    if (!parent) throw new Error('Cannot unwrap a detached element.');
    const children = Array.from(el.childNodes);
    const anchor = el.nextSibling;
    const before = serialize(el);

    for (const child of children) parent.insertBefore(child, el);
    parent.removeChild(el);

    return {
      kind: 'unwrapNode',
      computed: { unwrapped: children.filter((n) => n.nodeType === 1).length },
      before,
      after: children.map(serialize).join(''),
      undo() {
        if (!anchorIntact(parent, anchor)) {
          throw new Error(
            'Cannot undo unwrapNode: the original location changed since the mutation (page updated).',
          );
        }
        // Put the wrapper back at its own position first (the children currently sit before
        // `anchor`, so inserting there lands it immediately after them), then draw them back in —
        // which moves them out of the parent and restores the original nesting and order.
        parent.insertBefore(el, anchor);
        for (const child of children) el.appendChild(child);
      },
    };
  }

  /**
   * Replace an element and its whole subtree with new markup, as ONE reversible mutation.
   * The `<table>`-to-`<section><ul>` move.
   *
   * Deliberately not a `removeNode` composed with an `insertNode`. Those are two undo entries: a
   * single `undo` would restore the old subtree while the replacement is still on the page, or
   * remove the replacement and leave a hole — and the insert's anchor is the node the remove just
   * detached. Here the outgoing element is clipboard-retained (node identity, listeners and state
   * intact) and one `undo()` swaps it back for the replacement in a single step.
   */
  function replaceSubtree(el: Element, html: string): ElementMutation<{ html: string }> {
    const parent = el.parentNode;
    if (!parent) throw new Error('Cannot replace a detached element.');
    const nodes = nodesFromHtml(doc, html);
    if (nodes.length === 0) {
      // A replacement that sanitizes down to nothing is a removal, and `removeNode` records that
      // truthfully. Silently deleting the subtree here would be an unreviewable surprise.
      throw new Error(
        'replaceSubtree: `html` produced no content after sanitization; use removeNode to delete an element.',
      );
    }
    const before = serialize(el);
    const anchor = el.nextSibling;

    const frag = doc.createDocumentFragment();
    for (const node of nodes) frag.appendChild(node);
    parent.insertBefore(frag, el);
    parent.removeChild(el);

    const after = nodes.map(serialize).join('');
    return {
      kind: 'replaceNode',
      computed: { html: after },
      before,
      after,
      undo() {
        if (!anchorIntact(parent, anchor)) {
          throw new Error(
            'Cannot undo replaceSubtree: the original location changed since the mutation (page updated).',
          );
        }
        parent.insertBefore(el, anchor);
        for (const node of nodes) node.parentNode?.removeChild(node);
      },
    };
  }

  function injectCss(
    css: string,
    id = 'default',
  ): PageMutation<{ bytes: number; id: string; replaced: boolean }> {
    const denied = cssDenyReason(css);
    if (denied) throw new Error(denied);

    const existing = doc.querySelector(`style[${SHEET_ATTR}="${cssIdent(id)}"]`);
    const style = existing instanceof HTMLStyleElement ? existing : doc.createElement('style');
    const priorText: string | null =
      existing instanceof HTMLStyleElement ? style.textContent : null;

    style.textContent = css;
    if (!existing) {
      style.className = 'dz-designer-injected';
      style.setAttribute(SHEET_ATTR, id);
      // Last child of <head>, so page CSS loses ties on equal specificity without us reaching for
      // `!important` on every declaration the way the per-element override sheet has to.
      (doc.head ?? doc.documentElement).appendChild(style);
    }
    return {
      // `replaced` lets the model tell "I refined my design system" from "I added a second one" —
      // the distinction that makes iterate-and-refine legible in the changeset.
      computed: { bytes: css.length, id, replaced: priorText !== null },
      undo() {
        if (priorText === null) style.remove();
        else style.textContent = priorText;
      },
    };
  }

  function setViewport(size: {
    width: number;
    height?: number;
  }): PageMutation<{ width: number; height: number | null }> {
    // Content can't resize the OS window; it constrains the document to a width so CSS breakpoints
    // trigger. True device metrics come via CDP in the SW (responsive slice) — this is best-effort.
    const root = doc.documentElement;
    const prior = root.getAttribute('style');
    root.style.setProperty('width', `${size.width}px`);
    root.style.setProperty('max-width', `${size.width}px`);
    if (size.height != null) root.style.setProperty('min-height', `${size.height}px`);
    return {
      computed: { width: size.width, height: size.height ?? null },
      undo() {
        if (prior === null) root.removeAttribute('style');
        else root.setAttribute('style', prior);
      },
    };
  }

  return {
    setStyle,
    setText,
    setAttr,
    removeAttr,
    addClass,
    removeClass,
    insertNode,
    moveNode,
    removeNode,
    wrapNode,
    unwrapNode,
    replaceSubtree,
    injectCss,
    setViewport,
  };
}
