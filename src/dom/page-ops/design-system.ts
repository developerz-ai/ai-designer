// Reading the design system the page ALREADY HAS, from its stylesheets rather than from its pixels.
//
// `src/dom/identity.ts` samples rendered elements and infers a palette, a type scale and a spacing
// rhythm from computed values. That answers "what does this page look like". It cannot answer "what
// is this page BUILT from", because a computed `1rem` and a `var(--space-4)` are indistinguishable
// once the cascade has run — and for a full-page overhaul the second question is the one that
// matters. An overhaul that redefines `--space-4` changes the whole page coherently; one that
// writes `16px` in forty places is a mess a developer has to undo.
//
// So this reads the AUTHORED layer: custom properties actually declared, the breakpoints the page's
// own media queries use, the font stacks it declares, and how many rules there are to work with.
// Same-origin stylesheets only — a cross-origin `<link>` throws on `.cssRules`, which is caught and
// counted rather than allowed to fail the read.
//
// Pure DOM + injected document. No page JS is executed.

export interface DesignSystem {
  /** Declared custom properties, deduped, most-declared first: the page's real token set. */
  readonly tokens: readonly DesignToken[];
  /** Distinct `min-width`/`max-width` values across the page's media queries, ascending — the
   *  breakpoints the page actually uses, not the ones a framework's docs claim. */
  readonly breakpoints: readonly string[];
  /** Every distinct `@media` condition, verbatim, for the ones that are not width-based
   *  (`prefers-color-scheme`, `hover`, `prefers-reduced-motion`). */
  readonly mediaQueries: readonly string[];
  /** Declared `font-family` stacks, most-used first. */
  readonly fontStacks: readonly string[];
  /** `@font-face` families the page loads. */
  readonly fontFaces: readonly string[];
  readonly stats: {
    readonly sheets: number;
    /** Sheets whose rules could not be read (cross-origin). Their tokens are invisible here. */
    readonly unreadableSheets: number;
    readonly rules: number;
  };
}

export interface DesignToken {
  readonly name: string;
  /** The value as declared at the widest scope it appears in — usually `:root`. */
  readonly value: string;
  /** How many rules declare it. >1 usually means a theme override (dark mode, a scoped variant). */
  readonly declarations: number;
  /** The selectors it is declared on, capped. `:root` first when present. */
  readonly scopes: readonly string[];
}

const MAX_TOKENS = 120;
const MAX_SCOPES = 4;
const MAX_VALUE = 200;
const MAX_LISTS = 40;

interface TokenAcc {
  value: string;
  declarations: number;
  scopes: string[];
  rootValue?: string;
}

/**
 * Extract the page's authored design system. `doc` is the page document; every same-origin
 * stylesheet is walked once.
 */
export function readDesignSystem(doc: Document): DesignSystem {
  const tokens = new Map<string, TokenAcc>();
  const widths = new Set<string>();
  const conditions = new Set<string>();
  const fontStacks = new Map<string, number>();
  const fontFaces = new Set<string>();
  let unreadableSheets = 0;
  let rules = 0;

  const sheets = Array.from(doc.styleSheets);
  for (const sheet of sheets) {
    let list: CSSRuleList | null = null;
    try {
      list = sheet.cssRules;
    } catch {
      // Cross-origin stylesheet: the browser refuses to expose its rules. Counted, not swallowed —
      // a page whose tokens all live in a CDN sheet must not look like a page with no tokens.
      unreadableSheets += 1;
      continue;
    }
    rules += walk(list, tokens, widths, conditions, fontStacks, fontFaces);
  }

  return {
    tokens: rankTokens(tokens),
    breakpoints: sortWidths(widths),
    mediaQueries: [...conditions].slice(0, MAX_LISTS),
    fontStacks: [...fontStacks.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_LISTS)
      .map(([stack]) => stack),
    fontFaces: [...fontFaces].slice(0, MAX_LISTS),
    stats: { sheets: sheets.length, unreadableSheets, rules },
  };
}

// Recursively walk a rule list, collecting from style rules and descending into grouping rules
// (@media, @supports, @layer, @container). Returns the number of rules seen.
function walk(
  list: CSSRuleList,
  tokens: Map<string, TokenAcc>,
  widths: Set<string>,
  conditions: Set<string>,
  fontStacks: Map<string, number>,
  fontFaces: Set<string>,
  nested = false,
): number {
  let seen = 0;
  for (const rule of Array.from(list)) {
    seen += 1;
    const grouping = rule as CSSRule & { cssRules?: CSSRuleList; conditionText?: string };
    if (isStyleRule(rule)) {
      collectStyle(rule, tokens, fontStacks, nested);
      continue;
    }
    if (isFontFace(rule)) {
      const family = rule.style.getPropertyValue('font-family').trim();
      if (family) fontFaces.add(family.slice(0, MAX_VALUE));
      continue;
    }
    const condition = typeof grouping.conditionText === 'string' ? grouping.conditionText : '';
    if (condition) {
      const found = [...condition.matchAll(/(?:min|max)-width\s*:\s*([^)]+)/gi)];
      if (found.length > 0) for (const m of found) widths.add((m[1] ?? '').trim());
      else conditions.add(condition.trim().slice(0, MAX_VALUE));
    }
    if (grouping.cssRules) {
      seen += walk(grouping.cssRules, tokens, widths, conditions, fontStacks, fontFaces, true);
    }
  }
  return seen;
}

function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return typeof (rule as CSSStyleRule).selectorText === 'string';
}

function isFontFace(rule: CSSRule): rule is CSSRule & { style: CSSStyleDeclaration } {
  const style = (rule as { style?: CSSStyleDeclaration }).style;
  return (
    !isStyleRule(rule) && !!style && typeof style.getPropertyValue === 'function' && !!style.length
  );
}

function collectStyle(
  rule: CSSStyleRule,
  tokens: Map<string, TokenAcc>,
  fontStacks: Map<string, number>,
  nested: boolean,
): void {
  const selector = rule.selectorText;
  const style = rule.style;
  const family = style.getPropertyValue('font-family').trim();
  if (family) fontStacks.set(family.slice(0, MAX_VALUE), (fontStacks.get(family) ?? 0) + 1);

  for (let i = 0; i < style.length; i += 1) {
    const name = style.item(i);
    if (!name.startsWith('--')) continue;
    const value = style.getPropertyValue(name).trim().slice(0, MAX_VALUE);
    const acc = tokens.get(name) ?? { value, declarations: 0, scopes: [] };
    acc.declarations += 1;
    if (acc.scopes.length < MAX_SCOPES) acc.scopes.push(selector);
    // `:root` (or `html`) at the TOP LEVEL is the canonical declaration. A dark-mode override
    // inside `@media (prefers-color-scheme: dark)` has the same selector text and would otherwise
    // overwrite it — reporting the dark value as "the" token is exactly backwards for an overhaul.
    if (!nested && (selector === ':root' || selector === 'html')) acc.rootValue = value;
    tokens.set(name, acc);
  }
}

function rankTokens(tokens: Map<string, TokenAcc>): DesignToken[] {
  return [...tokens.entries()]
    .sort((a, b) => b[1].declarations - a[1].declarations || a[0].localeCompare(b[0]))
    .slice(0, MAX_TOKENS)
    .map(([name, acc]) => ({
      name,
      value: acc.rootValue ?? acc.value,
      declarations: acc.declarations,
      scopes: acc.scopes,
    }));
}

// Ascending by the numeric part so the list reads as a scale (`480px, 768px, 1024px`), with
// unparseable values kept at the end rather than dropped.
function sortWidths(widths: Set<string>): string[] {
  return [...widths]
    .sort((a, b) => {
      const na = Number.parseFloat(a);
      const nb = Number.parseFloat(b);
      if (!Number.isFinite(na)) return 1;
      if (!Number.isFinite(nb)) return -1;
      return na - nb;
    })
    .slice(0, MAX_LISTS);
}
