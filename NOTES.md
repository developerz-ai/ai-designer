# ai-designer

Developerz.ai Designer — a Chrome MV3 browser extension. You open any page (prod app or
localhost), chat with an agent in the side panel, and it live-edits the page DOM/CSS in real
time so you can see the change immediately. When you click **Ship**, the accumulated changeset
is handed over MCP to a dev-agent backend (ai-dev / developerz.ai) which makes the real code
change and opens a PR — or, standalone, downloads a Markdown report you can paste into a coding
agent. Aimed at developers and designers who want live visual iteration that ends in real code.
CLAUDE.md records the v0 design loop as shipped (slices 01–16).

- **Stack:** Bun + TypeScript + WXT + SolidJS + SCSS. Agent via AI SDK 7 (`ai`, `ToolLoopAgent`)
  against an OpenAI-compatible provider (`@ai-sdk/openai-compatible`, BYOK). Handoff over MCP
  (`@ai-sdk/mcp`, Streamable HTTP) with a Markdown-report fallback. Zod for validation, Biome
  for lint/format, Vitest (unit + integration) and Playwright (E2E). Ships as a browser
  extension zip; also contains a `site/` and `waitlist/`.
- **Key commands:** `bun run dev` (WXT HMR) · `bun run dev:firefox` · `bun run build` ·
  `bun run release` (build + zip) · `bun run test` (`test:unit`, `test:integration`,
  `test:e2e`) · `bun run typecheck` · `bun run lint` / `lint:fix`. A `justfile` is also present.
- **Layout:**
  - `src/entrypoints/` — the three MV3 worlds: `background.ts` (service worker: keys + network),
    `content.ts` (DOM access), `sidepanel/` (Solid UI)
  - `src/agent/` — agent loop, provider config, readiness, modes, budget, history
  - `src/dom/` — DOM read/mutate primitives, selector engine, picker overlay, recorder
  - `src/mcp/` + `src/changeset/` — MCP client/auth/routing; changeset store + Markdown report
  - `src/shared/` — Zod message/changeset schemas shared across worlds
  - `docs/`, `test/`, `site/`, `waitlist/`
- **State as of 2026-07-21:** branch `main`; working tree was clean when this note was written.
