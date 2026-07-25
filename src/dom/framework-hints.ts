// Per-element CSS-framework detection (#9) — pure string heuristics over the target's class
// tokens (+ the `data-styled` marker attribute), no network, no MAIN-world access. The recorder
// attaches the result to every element-targeting MutationEvent so the SW can fold it into
// `Edit.frameworkHints` (changeset.ts): the source-mapping bridge that tells the coding backend
// WHICH styling system a live edit belongs to (Tailwind utilities vs css-module locals vs
// styled/emotion generated classes). Complements `page-facts.ts` (page-level stack detection)
// with per-target evidence.

/** One hint per matched class, `<system>:<className>`; capped so a utility-soup element can't
 *  blow up the bus payload or the changeset. */
const HINT_CAP = 40;

// className is an SVGAnimatedString (not a string) on SVG elements, so read the attribute —
// same workaround as mutate.ts `classAttr`.
function classTokens(el: Element): string[] {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

// --- Tailwind ---------------------------------------------------------------
// The utility-base probe, applied AFTER stripping responsive/state variant prefixes
// (`md:hover:bg-…` → `bg-…`). Intentionally liberal (`text-.+`, `border.*`): the false-positive
// guard is the ≥2-matches-per-element rule below, not the regex — a hand-named `flex` or `shadow`
// class on a non-Tailwind page is common, a cluster of utility-shaped tokens is not.
const TAILWIND_BASE =
  /^-?(?:flex|grid|block|hidden|inline(?:-block|-flex|-grid)?|p[trblxy]?-.+|m[trblxy]?-.+|text-.+|font-.+|bg-.+|rounded.*|shadow.*|w-.+|h-.+|min-w-.+|max-w-.+|min-h-.+|max-h-.+|items-.+|justify-.+|content-.+|self-.+|place-.+|gap-.+|space-[xy]-.+|border.*|ring.*|outline.*|divide-.+|leading-.+|tracking-.+|z-.+|opacity-.+|order-.+|col-.+|row-.+|grow.*|shrink.*|basis-.+|inset-.+|top-.+|right-.+|bottom-.+|left-.+|overflow-.+|object-.+|cursor-.+|select-.+|transition.*|duration-.+|ease-.+|delay-.+|scale-.+|rotate-.+|translate-.+|skew-.+|whitespace-.+|break-.+|list-.+|placeholder-.+|decoration-.+|underline|line-through|no-underline|uppercase|lowercase|capitalize|normal-case|truncate|antialiased|italic|not-italic|absolute|relative|fixed|sticky|static|visible|invisible|collapse|table|container|sr-only|not-sr-only|pointer-events-.+|appearance-none|transform)$/;

function isTailwindToken(token: string): boolean {
  // Strip `variant:` prefixes (responsive `md:`, state `hover:`/`focus:`, group/peer, dark…) —
  // last segment is the utility base. Arbitrary values may contain `:` inside `[…]`
  // (`bg-[url(http://…)]`); the stripped remnant then fails the base probe, which is the honest
  // answer for a heuristic.
  const base = token.includes(':') ? token.slice(token.lastIndexOf(':') + 1) : token;
  return TAILWIND_BASE.test(base);
}

// --- css modules --------------------------------------------------------------
// Generated-local shapes: `<name>__<local>___<hash>` / `<name>_<local>__<hash>` (css-loader
// localIdentName variants) and `_<segment>[_<hash>[_<n>]]` leading-underscore generated segments
// (Vite's default `[name]_[local]_[hash]` loses the name at the start). The hash tail (≥4–5
// base62-ish chars) is the tell — a human-named class rarely carries one.
const CSS_MODULE = /^(?:[A-Za-z][\w-]*_[\w-]*__[\w-]{4,}|_[\w-]{5,}(?:_[\w-]+){0,2})$/;

// --- styled-components / emotion ----------------------------------------------
// styled-components tags every styled element with its componentId class `sc-<hash>`
// (v5+; ≥4 hash chars so `sc-1` false-alarm shapes don't qualify). Newer versions also emit a
// `data-styled` marker attribute — a classless signal, reported as a bare `styled:` marker.
const STYLED = /^sc-[\w-]{4,}$/;
// Emotion's generated class is `css-<hash>` (optionally `css-<hash>-<label>` with the babel
// plugin). ≥4 tail chars, same false-alarm reasoning as styled.
const EMOTION = /^css-[\w-]{4,}$/;

/** Detect the CSS approach(es) of ONE element from its class tokens + marker attributes.
 *  Pure: no reads beyond `el`'s own attributes. Returns ≤ {@link HINT_CAP} hints, empty when
 *  nothing matches. */
export function detectFrameworkHints(el: Element): string[] {
  const tokens = classTokens(el);
  const hints: string[] = [];

  // Tailwind: emit ONLY on a cluster (≥2 utility-shaped tokens on the same element) — a single
  // match is as likely a hand-named class as a utility, so one token says nothing.
  const tailwind = tokens.filter(isTailwindToken);
  if (tailwind.length >= 2) {
    for (const token of tailwind) hints.push(`tailwind:${token}`);
  }

  for (const token of tokens) {
    if (CSS_MODULE.test(token)) hints.push(`css-module:${token}`);
    else if (STYLED.test(token)) hints.push(`styled:${token}`);
    else if (EMOTION.test(token)) hints.push(`emotion:${token}`);
  }
  if (el.hasAttribute('data-styled')) hints.push('styled:data-styled');

  return [...new Set(hints)].slice(0, HINT_CAP);
}
