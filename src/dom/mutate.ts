import { readComputed } from '@/dom/read';
import type { MutationKind } from '@/shared/messages';

// Reversible mutation primitives — the content script's write half. Each primitive applies a
// change, captures enough prior state to reverse it EXACTLY, and returns the computed result for
// the model to reason over. Styles go through an injected stylesheet (never inline) so an edit is
// one droppable rule that wins the cascade; structural edits clipboard-track the moved/removed
// node for undo. Pure DOM (no chrome.*) → jsdom-testable. See docs/idea/live-edit.md.

const SHEET_ID = 'dz-designer-overrides';

/** Our private per-element marker. setStyle tags a target with a generated id and writes
 *  `[data-dz-designer="dz-N"] { … }` into the overrides sheet, so an edit reverses to a precise
 *  rule even for anonymous elements. The recorder (slice 05) ignores this attribute. */
export const MARKER_ATTR = 'data-dz-designer';

export interface Reversible {
  /** Restore the exact prior state. Called LIFO with the recorder's undo log. */
  undo(): void;
}

// An element-targeting mutation: it contributes a recorder `MutationEvent` (kind + before/after
// serialized state, messages.ts). `computed` is the post-change value the model reads back.
export interface ElementMutation<C = unknown> extends Reversible {
  kind: MutationKind;
  computed: C;
  before: string;
  after: string;
  /** The overrides-sheet rule id (the element marker) for a `setStyle`, so undo can drop it. */
  ruleId?: string;
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
  injectCss(css: string): PageMutation<{ bytes: number }>;
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
// to the first element or getting wrapped in a span. Inline on*-handlers, which the <template> defers
// but insertion would make live, are stripped first (see stripEventHandlers).
function nodesFromHtml(doc: Document, html: string): Node[] {
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  stripEventHandlers(tpl.content);
  const frag = doc.importNode(tpl.content, true);
  return Array.from(frag.childNodes);
}

// Drop inline event-handler attributes (`onclick`, `onerror`, `onload`, …) from every imported
// element. A <template> defers them, but insertion makes them live — stripping keeps agent-authored
// markup from running page JS once inserted. Resource attrs (`src`/`href`) stay: a plain load is not
// code execution and the markup is agent-authored, not remote.
function stripEventHandlers(frag: DocumentFragment): void {
  for (const el of frag.querySelectorAll('*')) {
    for (const name of el.getAttributeNames()) {
      if (name.toLowerCase().startsWith('on')) el.removeAttribute(name);
    }
  }
}

function serialize(node: Node): string {
  return node instanceof Element ? node.outerHTML : (node.textContent ?? '');
}

// Attribute names refused outright: each loads a remote resource, injects/executes a framed
// document, or exfiltrates — none has a legitimate use in an agent design edit. `srcdoc` and
// `<object data="…text/html">` in particular execute script in a (nested) browsing context, which
// setStyle's url() cannot. Includes our private setStyle marker so an agent can't corrupt the
// overrides map. (`src` on iframe/img, `srcset`, `poster`, `ping`, `data` on object/embed.)
const DENIED_ATTR_NAMES = new Set([
  'src',
  'srcset',
  'poster',
  'ping',
  'data',
  'srcdoc',
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

/**
 * A page-bound reversible mutator. Holds the injected overrides stylesheet + per-element override
 * maps so repeated `setStyle`s on one element merge into a single rule and unwind precisely. One
 * instance per page (the content script owns it); pass a jsdom `document` in tests.
 */
export function createMutator(doc: Document = document): Mutator {
  let markerSeq = 0;
  // marker id -> its current kebab prop overrides; the source of truth serialized into the sheet.
  const overrides = new Map<string, Map<string, string>>();

  function ensureSheet(): HTMLStyleElement {
    const existing = doc.getElementById(SHEET_ID);
    if (existing instanceof HTMLStyleElement) return existing;
    const style = doc.createElement('style');
    style.id = SHEET_ID;
    (doc.head ?? doc.documentElement).appendChild(style);
    return style;
  }

  function renderSheet(): void {
    const blocks: string[] = [];
    for (const [id, props] of overrides) {
      if (props.size === 0) continue;
      const body = Array.from(props, ([prop, value]) => `${prop}: ${value} !important;`).join(' ');
      blocks.push(`[${MARKER_ATTR}="${id}"] { ${body} }`);
    }
    ensureSheet().textContent = blocks.join('\n');
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
    const map = overrides.get(id) ?? new Map<string, string>();
    overrides.set(id, map);

    const entries = Object.entries(props).map(([prop, value]) => [toKebab(prop), value] as const);
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
    return {
      kind: 'setStyle',
      ruleId: id,
      before,
      after: JSON.stringify(fallback),
      computed: readComputed(
        el,
        entries.map(([prop]) => prop),
        fallback,
      ),
      undo() {
        const map = overrides.get(id);
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
    el.textContent = value;
    return {
      kind: 'setText',
      computed: value,
      before,
      after: value,
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
      undo() {
        if (prev !== null) el.setAttribute(name, prev);
        else el.removeAttribute(name);
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
        if (parent) parent.insertBefore(el, next);
        else el.remove();
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
        if (parent) parent.insertBefore(el, next);
      },
    };
  }

  function injectCss(css: string): PageMutation<{ bytes: number }> {
    const style = doc.createElement('style');
    style.className = 'dz-designer-injected';
    style.textContent = css;
    (doc.head ?? doc.documentElement).appendChild(style);
    return {
      computed: { bytes: css.length },
      undo() {
        style.remove();
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
    addClass,
    removeClass,
    insertNode,
    moveNode,
    removeNode,
    injectCss,
    setViewport,
  };
}
