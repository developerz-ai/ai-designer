# 14 — Describe-in-text + design identity (colors/type) extraction

> Part of [`overview.md`](overview.md). Depends on: 05 (read), 06 (browse/copy), 13 (screenshot/readImages). World: **content script** (extract) + **service worker** (vision describe). Spec: `.codegraph/vision.txt`, `docs/idea/agent.md`.

## Why
Two asks: **"describe in text stuff"** — the agent needs to turn a page/region/image into a compact **text description** (so a non-vision model, a report, or a handoff spec can reason without pixels). **"identity colors"** — extract a site's **visual identity** (color palette, typography, spacing, radius) so *copy* actually reuses the source's brand, and *reports* speak in tokens not raw values. Today only raw `getStyles`/a11y exist; no palette/identity, no textual scene description.

## Tools to add (`DomTool` schema in `messages.ts` + `tool()` in `src/agent/tools/`)
| Tool | Args | Returns |
|------|------|---------|
| `describe` | `Target?, selector?, mode: 'layout'\|'content'\|'scene'` | Compact **text** description: layout mode → regions/hierarchy (nav/hero/grid/footer) from a11y+DOM; content mode → salient copy/labels; scene mode → SW screenshots the region and asks the **vision model** for a prose description ("dark hero, centered headline, orange CTA right"). Non-vision fallback = DOM/a11y only. |
| `extractIdentity` | `Target?, scope?` | **Design identity**: dominant + accent **color palette** (with roles: bg/fg/accent/border, frequency-ranked from computed styles + key images), **type scale** (families, sizes, weights), spacing rhythm, border-radius, shadow style. Normalized to a token-like shape. |
| `readImageContent` | `Target, selector` | For a specific `<img>`/media: alt + a **vision text description** of what the image depicts (feeds copy/report when alt is missing). Cost-aware (vision only on request). |

## Files to change
- `src/dom/identity.ts` — **new** (content). Walk computed styles of visible elements + sample key images → frequency-rank colors into roles; collect font families/sizes/weights, spacing multiples, radii, shadows. Pure-ish, bounded (cap element sample).
- `src/dom/describe.ts` — **new** (content). Build the layout/content text description from `selector.ts` regions + a11y roles + headings; compact + token-bounded.
- `src/agent/tools/describe.ts` — **new**. `describe` / `readImageContent` `tool()`; scene/image modes call the vision model in the SW (reuse 13 `inspectVisually` path), text modes stay DOM-only (cheap).
- `src/agent/tools/identity.ts` — **new**. `extractIdentity` `tool()` → content `dom/identity.ts`; result shaped so `06` copy can apply it + `07` report can render it as tokens.
- `src/shared/messages.ts` — add `DescribeCmd`, `IdentityResult` (palette roles + type scale + spacing + radius + shadow), `ImageDescription` schemas + `ToolResult` variants.
- `src/entrypoints/content.ts` — route `describe`/`extractIdentity`/`readImageContent` into the new modules.
- `src/agent/system-prompt.ts` (04) + `src/agent/modes.ts` (06) — copy mode: **first `extractIdentity` on the reference, then apply its palette/type to the user's page**; debug/report: use `describe` to narrate the current state + the failure. Prefer `describe` (text) over a screenshot when a vision call isn't warranted (cost).
- `src/changeset/report.ts` (07) — render extracted identity as a **tokens table** (color roles, type scale) + textual descriptions, so the MD/handoff is concise and codebase-ready.

## Steps
1. `dom/identity.ts` palette+type extraction (frequency-ranked, role-tagged, bounded sample).
2. `dom/describe.ts` layout/content text builder from a11y + regions.
3. `tools/{describe,identity}.ts` derivations; scene/image modes route to the vision model, text modes DOM-only.
4. Schemas in `messages.ts`; content routing.
5. Wire copy mode to `extractIdentity`→apply; wire report to render identity as tokens + descriptions.

## Tests
- Unit (jsdom): `dom/identity` ranks colors into roles + derives a type scale from a fixture; `dom/describe` produces a bounded layout description; schemas validate.
- Integration: `extractIdentity` over the bus → identity result; `describe` scene mode with a mocked vision model → prose; copy mode applies extracted palette to a target fixture.
- E2E: copy a fixture "reference" page → agent extracts its identity → applies palette/type to the user's fixture → report renders the tokens table.
- `bun run typecheck`, `bun run lint`.

## Done when
- `describe` returns a compact **text** description of a page/region/image (DOM-only cheap path + optional vision scene path).
- `extractIdentity` returns a site's color palette (role-tagged) + type scale + spacing/radius/shadow, driving copy and rendered as tokens in reports/handoff.
- Copy mode reuses the reference's identity; reports read in tokens, not raw hex. Gate green.
