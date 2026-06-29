import type { SelectorStrategy, StableSelector } from '@/shared/changeset';

// Resilient selector resolution — never brittle nth-child chains.
// See docs/idea/live-edit.md "Stable selectors". Pure + testable: pass a
// minimal element-like shape so it runs under jsdom and in unit tests.

export interface ElementLike {
  getAttribute(name: string): string | null;
  readonly id: string;
  readonly tagName: string;
  readonly textContent: string | null;
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
 * Pure — takes only an element-like shape, never touches a document. Uniqueness +
 * round-trip verification is intentionally NOT done here (there is no document to
 * scope against); it belongs in the DOM consumers (#4 `query`, #6 picker), which
 * run `querySelectorAll(value).length === 1` against the live page and keep the
 * first candidate that uniquely re-selects the element. Always returns at least one
 * candidate (the text / css-path structural fallback).
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

  // Structural fallback (always present, fragile). Text content can't be matched
  // by querySelector, so the candidate value is the valid bare tag; the `text`
  // strategy is the heuristic the dev-agent uses to relocate the element by its
  // visible text during source-mapping. Without usable text it degrades to css-path.
  const text = el.textContent?.trim();
  candidates.push(
    text && text.length <= 50 ? make(tag, 'text', true) : make(tag, 'css-path', true),
  );

  return candidates;
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
