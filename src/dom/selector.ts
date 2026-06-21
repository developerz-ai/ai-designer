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
 * Resolve the most stable selector for an element, in priority order:
 * data-attr -> id -> aria -> text -> css-path (fragile, flagged).
 */
export function resolveSelector(el: ElementLike): StableSelector {
  for (const name of STABLE_DATA_ATTRS) {
    const v = attr(el, name);
    if (v) return make(`[${name}=${cssValue(v)}]`, 'data-attr');
  }

  if (el.id && !GENERATED_ID.test(el.id)) {
    return make(`#${cssEscape(el.id)}`, 'id');
  }

  const role = attr(el, 'role');
  const label = attr(el, 'aria-label');
  if (role && label) {
    return make(
      `${el.tagName.toLowerCase()}[role=${cssValue(role)}][aria-label=${cssValue(label)}]`,
      'aria',
    );
  }

  const text = el.textContent?.trim();
  if (text && text.length <= 50) {
    return make(`${el.tagName.toLowerCase()}:has-text(${cssValue(text)})`, 'text');
  }

  // Last resort — caller should treat this as fragile.
  return make(el.tagName.toLowerCase(), 'css-path', true);
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
