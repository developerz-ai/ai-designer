# CLAUDE.md

Developerz.ai Designer — Chrome MV3 extension. Chat with an agent → it live-edits the page DOM/CSS in real time → on Ship, hands a changeset over MCP to ai-dev/developerz.ai which makes the real code change and opens a PR.

Spec/scaffold phase. Docs: `docs/idea/`, `docs/architecture/`.

## Stack

Bun + TypeScript + WXT + SolidJS + SCSS. Agent: Vercel AI SDK + OpenRouter (BYOK). Handoff: MCP (`@modelcontextprotocol/sdk`). Validate: Zod. Lint/format: Biome. Tests: Vitest (unit+integration) + Playwright (E2E).

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

## Don't

- Commit secrets/keys. BYOK — keys live in `chrome.storage.local`, encrypted, never in the repo.
- Persist live page mutations to any server. Only durable output = changeset → PR.
- Auto-ship. "Ship" is user-triggered.

House style for docs/config: lead with the rule, fragments over sentences, tables for structured data, no meta-framing — `github.com/sebyx07/claude-code-bible` ch.11.
