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

// Parse `html` into a single node to insert. Uses a <template> whose content is inert (no scripts
// run, no remote code fetched — CSP-safe), then imports the first element into the live document.
function nodeFromHtml(doc: Document, html: string): Node {
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  const first = tpl.content.firstElementChild;
  if (first) return doc.importNode(first, true);
  const span = doc.createElement('span');
  span.textContent = html;
  return span;
}

function serialize(node: Node): string {
  return node instanceof Element ? node.outerHTML : (node.textContent ?? '');
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
    const before = el.textContent ?? '';
    el.textContent = value;
    return {
      kind: 'setText',
      computed: value,
      before,
      after: value,
      undo() {
        el.textContent = before;
      },
    };
  }

  function setAttr(el: Element, name: string, value: string): ElementMutation<string> {
    const had = el.hasAttribute(name);
    const before = el.getAttribute(name) ?? '';
    el.setAttribute(name, value);
    return {
      kind: 'setAttr',
      computed: value,
      before,
      after: value,
      undo() {
        if (had) el.setAttribute(name, before);
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
    const node = nodeFromHtml(doc, html);
    insertAt(ref, node, position);
    const after = serialize(node);
    return {
      kind: 'insertNode',
      computed: { html: after },
      before: '',
      after,
      undo() {
        node.parentNode?.removeChild(node);
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
