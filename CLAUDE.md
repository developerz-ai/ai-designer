# CLAUDE.md

Developerz.ai Designer — Chrome MV3 extension. Chat with an agent → it live-edits the page DOM/CSS in real time → on Ship, hands a changeset over MCP to ai-dev/developerz.ai which makes the real code change and opens a PR.

v0 design loop shipped (chat → live edits → changeset → ship/report; slices 01–16). Docs: `docs/idea/`, `docs/architecture/`.

## Stack

Bun + TypeScript + WXT + SolidJS + SCSS. Agent: AI SDK 7 (`ai`, `ToolLoopAgent`) + OpenAI-compatible provider (`@ai-sdk/openai-compatible`, BYOK, runtime config). Handoff: MCP via `@ai-sdk/mcp` (`createMCPClient`, Streamable HTTP) or MD-report download (fallback). Validate: Zod. Lint/format: Biome. Tests: Vitest (unit+integration) + Playwright (E2E). See `docs/reference/agent-sdk.md`.

## MV3 three worlds — load-bearing

- **Keys + network ONLY in the service worker** (`src/entrypoints/background.ts`). NEVER put the OpenRouter key or MCP tokens in a content script — it shares the page's world.
- **DOM access ONLY in the content script** (`src/entrypoints/content.ts`). Service worker has no DOM; proxy all page reads/writes via the typed message bus.
- **UI ONLY in the side panel** (`src/entrypoints/sidepanel/`). Own origin, CSP-clean.
- Messages between worlds: Zod-validated in `src/shared/`. No `any` across the bus.
- No remote code, no `eval` — Solid is prebuilt to static JS.

## SolidJS + SRP

- One component = one `.tsx` + co-located `.scss`. Same basename.
- One module = one responsibility. Small files. Split when a file does two things.
- NO business logic in components. Logic lives in `src/agent/`, `src/dom/`, `src/mcp/`, `src/changeset/`. Components render + dispatch only.
- State via signals/stores (`createSignal`, `createStore`) — NEVER prop-drill more than one level; lift to a store.
- Derive with `createMemo`; side effects in `createEffect`. No manual DOM in components.

## Module map (by world)

| Module | World | Responsibility |
|--------|-------|-----------------|
| `src/agent/` | SW | Loop (`ToolLoopAgent`), provider + config, readiness, modes (copy/debug/browse), session, budget, history store, browser-control tools |
| `src/dom/` | Content | Read/mutate primitives, selector engine, picker overlay, recorder, diagnostics (viewport/scroll/perf), identity/describe, charts/widget recipes, responsive scanner |
| `src/mcp/` | SW | MCP client + manager, auth (API key / OAuth+PKCE), server store, handoff routing (MCP task or MD-report fallback) |
| `src/changeset/` | SW | Store (undo/redo), Markdown report renderer (`toMarkdown`), session record |
| `src/entrypoints/sidepanel/` | Panel | Solid SPA (chat, MCP, history, settings) + stores (chat, mcp, readiness, settings) |
| `src/entrypoints/background.ts` | SW | Loop bootstrap, message-bus host, overlay-step relay, session restore |
| `src/entrypoints/content.ts` | Content | DOM bridge (isolated), picker mount, overlay mount, recorder relay |
| `src/entrypoints/injected.content.ts` | MAIN | Page-facts + chart-lib bridge (read-only, no secrets) |
| `src/shared/` | all | Zod schemas (messages, changeset, report, overlay), port/relay plumbing |
| `src/entrypoints/sidepanel/components/Icon.tsx` | Panel | FontAwesome SVG-core inline, tree-shaken (no remote fetch, CSP-clean) |

## SCSS

- Co-located with the component. Scope to a root class (`.chat-panel { ... }`); BEM-ish for children.
- Tokens (colors, spacing, radius) in `src/styles/_tokens.scss`. NEVER hardcode a hex/px that's a token.

## Commands

| | |
|--|--|
| dev | `bun run dev` (WXT, HMR) · `bun run dev:firefox` |
| build | `bun run build` · release: `bun run release` (build + zip, minified) |
| test | `bun run test` · unit: `test:unit` · integration: `test:integration` · e2e: `test:e2e` |
| check | `bun run typecheck` · `bun run lint` (fix: `lint:fix`) |

## Before a PR

- `bun run lint` clean, `bun run typecheck` clean, unit + integration green.
- New module → add a unit test. New cross-world flow → add an integration test.

## Readiness + Start

Before chatting, the agent checks readiness via a truth table: provider + model configured + host permission granted + MCP backends (if any) reachable. UI shows status via ReadinessDropdown (Leo-style pill) with a Fix deep-link per failing row. User clicks Start → loop boots. Modes: copy / debug / none — pinned via `UserMessage.mode` or inferred from the message text (`src/agent/modes.ts`); no mode picker UI. Browse is a tool, not a mode. Ship routes to MCP task create (if backend connected) or Markdown report download (fallback; `.md` to the download folder).

## Outputs

- **Live edits** → changeset (undo/redo) + agent-authored report (identity + findings)
- **On Ship** → MCP task to ai-dev/backend (if connected) → real PR in ~minutes; OR `.md` download (standalone usage, paste into coding agent)
- **History** → last 10 sessions + reports (ring buffer, `chrome.storage.local`)

## Don't

- Commit secrets/keys. BYOK — keys live in `chrome.storage.local`, encrypted, never in the repo.
- Persist live page mutations to any server. Only durable output = changeset + report → PR or report `.md`.
- Auto-ship. "Ship" is user-triggered.

House style for docs/config: lead with the rule, fragments over sentences, tables for structured data, no meta-framing — `github.com/sebyx07/claude-code-bible` ch.11.
