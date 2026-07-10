import type { SelectorStrategy, StableSelector } from '@/shared/changeset';

// Resilient selector resolution — never brittle nth-child chains.
// See docs/idea/live-edit.md "Stable selectors". Pure + testable: pass a
// minimal element-like shape so it runs under jsdom and in unit tests.

export interface ElementLike {
  getAttribute(name: string): string | null;
  readonly id: string;
  readonly tagName: string;
  readonly textContent: string | null;
  // Optional tree links. A real DOM Element supplies them; the minimal unit-test
  // fakes omit them, so the css-path generator degrades to a bare tag when absent.
  readonly parentElement?: ElementLike | null;
  readonly previousElementSibling?: ElementLike | null;
}

const STABLE_DATA_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
// Generated ids (hashed / framework) are not stable enough to ship.
const GENERATED_ID = /[0-9a-f]{6,}|:r[0-9a-z]+:|^css-|^sc-/i;

function attr(el: ElementLike, name: string): string | null {
  const v = el.getAttribute(name);
  return v && v.trim() !== '' ? v : null;
}

/**
 * Resolve an element to an ordered list of stable selector *candidates*, most
 * stable first: data-attr -> id -> aria -> text -> css-path. Every candidate's
 * `value` is a syntactically valid `document.querySelector` string (no Playwright
 * `:has-text()` pseudo). The returned array IS the emitted heuristics: each
 * candidate carries the `strategy` that produced it, and fragile ones are flagged.
 *
 * Pure — element-like in, candidates out. Never takes a `document` and never runs a
 * query; it reads only the element and its own ancestor/sibling links. The
 * structural fallback is a scoped `nth-of-type` css-path (see {@link cssPath}), which
 * uniquely re-selects the element wherever the DOM allows it. Identity-checked
 * uniqueness against a live document is {@link pickUnique}'s job — the one function
 * that takes a `doc`. Always returns at least one candidate (the structural fallback).
 */
export function resolveSelector(el: ElementLike): StableSelector[] {
  const candidates: StableSelector[] = [];
  const tag = el.tagName.toLowerCase();

  for (const name of STABLE_DATA_ATTRS) {
    const v = attr(el, name);
    if (v) candidates.push(make(`[${name}=${cssValue(v)}]`, 'data-attr'));
  }

  if (el.id && !GENERATED_ID.test(el.id)) {
    candidates.push(make(`#${cssEscape(el.id)}`, 'id'));
  }

  const role = attr(el, 'role');
  const label = attr(el, 'aria-label');
  if (role && label) {
    candidates.push(make(`${tag}[role=${cssValue(role)}][aria-label=${cssValue(label)}]`, 'aria'));
  }

  // Structural fallback (always present, fragile). Text content can't be matched by
  // querySelector, so a text-bearing element keeps a bare-tag `text` candidate — the
  // heuristic the dev-agent uses to relocate the element by its visible text during
  // source-mapping. Without usable text it degrades to a scoped css-path that actually
  // re-selects the element.
  const text = el.textContent?.trim();
  candidates.push(
    text && text.length <= 50 ? make(tag, 'text', true) : make(cssPath(el), 'css-path', true),
  );

  return candidates;
}

/**
 * Pick the single stable selector that resolves to *exactly* `el` within `doc`.
 * Walks {@link resolveSelector}'s ranked candidates and returns the first one whose
 * value selects this and only this element — `hits.length === 1 && hits[0] === el`.
 * A bare count check is a bug: a different single element can match, so a candidate
 * that resolves to one *wrong* element is rejected. When nothing uniquely resolves,
 * degrades to the scoped css-path flagged `fragile` rather than throwing. The one and
 * only function here that takes a `doc`.
 */
export function pickUnique(el: Element, doc: ParentNode): StableSelector {
  for (const candidate of resolveSelector(el)) {
    if (resolvesToExactly(doc, candidate.value, el)) return candidate;
  }
  return make(cssPath(el), 'css-path', true);
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
 * Build a scoped `nth-of-type` css-path that uniquely re-selects `el`. Walks up the
 * ancestor chain emitting `tag:nth-of-type(n)` per level, anchoring at the nearest
 * ancestor with a stable id (`#id > ...`) for a shorter, more resilient scope, else
 * up to the root. Degrades to a bare tag when the element-like exposes no tree.
 */
function cssPath(el: ElementLike): string {
  const segments: string[] = [];
  let cur: ElementLike | null | undefined = el;
  let isTarget = true;
  while (cur) {
    const tag = cur.tagName.toLowerCase();
    if (!isTarget && cur.id && !GENERATED_ID.test(cur.id)) {
      segments.unshift(`#${cssEscape(cur.id)}`);
      break;
    }
    const parent: ElementLike | null | undefined = cur.parentElement;
    segments.unshift(parent ? `${tag}:nth-of-type(${nthOfType(cur)})` : tag);
    cur = parent;
    isTarget = false;
  }
  return segments.join(' > ');
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
  return `"${v.replace(/"/g, '\\"')}"`;
}

function cssEscape(v: string): string {
  return v.replace(/([^\w-])/g, '\\$1');
}
