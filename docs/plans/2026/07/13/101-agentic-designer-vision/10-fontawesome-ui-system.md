# 10 — FontAwesome + UI system (CSP-clean)

> Part of [`overview.md`](overview.md). Depends on: none (do early — 03/07/08/11 consume it). World: **side panel** (+ content overlay reuse). Skill: `solid-srp`.

## Why
User: "fontawesome". MV3 CSP forbids remote code + external CDN/font fetches — so **self-host** FontAwesome, don't `<link>` a CDN. One `Icon` component keeps SRP and lets every panel share iconography (matches Leo's clean icon-led header). Establish this before the icon-heavy slices.

## Files to change
- `package.json` — add `@fortawesome/fontawesome-svg-core` + `@fortawesome/free-solid-svg-icons` (+ brands if needed). **SVG-core (tree-shaken JS), not the webfont** — avoids remote font + shrinks bundle; CSP-safe (bundled JS, no eval).
- `src/entrypoints/sidepanel/components/Icon.tsx` + `.scss` — **new**. Thin SolidJS wrapper: `props { name, size?, spin?, class? }` → renders the imported icon's SVG inline (via `icon()` from svg-core → static SVG markup; **no `innerHTML` of remote content**). Register the subset of icons actually used (tree-shake). SRP: presentational only.
- `src/styles/_tokens.scss` — add icon-size + status-color tokens (connected/error/warning/muted) so icons theme via tokens, never hardcoded hex/px (CLAUDE.md SCSS rule). Also define the extension's **brand identity colors** (developerz.ai palette — primary/accent/surface/on-surface) as the one source of truth; the whole UI derives from these. (Distinct from a *target site's* extracted identity, which is slice `14`.)
- `src/styles/_mixins.scss` (create if absent) — icon-button + status-dot mixins reused across panels.
- WXT/Vite build — confirm the svg-core bundle is inlined (no runtime font request); verify against CSP.

## Steps
1. Add deps (Bun). Choose svg-core approach (import individual icons, register once).
2. `Icon.tsx`: map a small `name` union → imported icon definitions; render inline SVG; size/spin via props → SCSS tokens.
3. Add tokens + mixins; document the icon-name union so other slices reuse it.
4. Verify no external network/font request at runtime (check Network + CSP in a loaded build).

## Tests
- Unit: `Icon` renders the expected SVG for a name; unknown name → safe fallback; size/spin classes applied.
- Build/CSP: a Playwright check that loads the panel and asserts **no** blocked/remote font or script requests (extend `test/e2e/smoke.spec.ts`).
- `bun run typecheck`, `bun run lint`.

## Done when
- `<Icon name="..."/>` renders bundled, tree-shaken SVG icons; no CDN/webfont fetch; CSP clean.
- Icon sizes/status colors come from `_tokens.scss`. Other slices import `Icon`. Gate green.
