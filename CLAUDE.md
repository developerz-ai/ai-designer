# CLAUDE.md

Developerz.ai Designer — Chrome MV3 extension. Chat with an agent → it live-edits the page DOM/CSS in real time → on Ship, hands a changeset over MCP to developerz.ai, which makes the real code change and opens a PR.

v0 design loop shipped (chat → live edits → changeset → ship/report). Why the repo is shaped this way: `docs/idea/principles.md`. How work is done here: `docs/idea/ai-first.md`.

## Non-negotiables

| Rule | Anchor |
|------|--------|
| Keys, network and MCP tokens ONLY in the service worker — NEVER in a content script (it shares the page's world) | `src/entrypoints/background.ts` |
| DOM access ONLY in the content script — the service worker has no DOM; proxy every page read/write over the typed bus | `src/entrypoints/content.ts` |
| UI ONLY in the side panel — own origin, CSP-clean | `src/entrypoints/sidepanel/` |
| Every cross-world message Zod-validated in `src/shared/`. No `any` across the bus | `src/shared/messages.ts` |
| No remote code, no `eval` — Solid is prebuilt to static JS | `wxt.config.ts` |
| The service worker is ephemeral — state that must survive a restart MUST live in `chrome.storage.session` | `src/agent/session.ts` |
| BYOK only — keys AES-GCM-encrypted in `chrome.storage.local`, never in the repo | `src/agent/key-store.ts` |
| Live edits are ephemeral — MUST NOT persist page mutations to any server. Durable output = changeset → PR, or a Markdown report | `src/changeset/store.ts` |
| Ship is user-triggered — NEVER auto-ship, never auto-merge | `src/mcp/handoff.ts` |
| The Ship dispatch verb `task` MUST NOT enter a design turn — only the user-clicked Ship RPC dispatches it | `src/mcp/design-gate.ts` |
| Any other write-shaped MCP tool needs an explicit per-server, per-tool grant — a granted one DOES enter a design turn | `src/mcp/tool-grants.ts` |
| No business logic in components — logic lives in `src/agent/`, `src/dom/`, `src/mcp/`, `src/changeset/` | `src/entrypoints/sidepanel/` |
| SCSS tokens only — MUST NOT hardcode a hex/px that is a token | `src/styles/_tokens.scss` |
| Permissions least-privilege — `<all_urls>` optional, never static | `wxt.config.ts` |
| Crash telemetry: error events only, allowlisted fields, page breadcrumbs dropped | `src/shared/sentry.ts` |
| i18n strings live in `src/locales/en.yml` — no hardcoded UI copy (one live exception: `src/entrypoints/sidepanel/components/UsageMeter.tsx`) | `src/locales/en.yml` |
| On the shared stack: NEVER `git stash`, force-push, or skip hooks | `.claude/commands/feature.md` |

## Stack

| Layer | Choice |
|-------|--------|
| Runtime + package manager | Bun 1.4.4 |
| Language | TypeScript 7 — `bun run typecheck` runs **tsgo** (`@typescript/native-preview`); `bun run typecheck:tsc` runs stock tsc to bisect a disagreement |
| Extension framework | WXT 0.20 — entrypoints, manifest, dev/build |
| UI | SolidJS 1.9, prebuilt static bundle (CSP-clean) + SCSS (`sass`) |
| Agent loop | AI SDK 7 — `ToolLoopAgent` (`ai`) |
| Provider | `@ai-sdk/openai-compatible` — any `/v1` endpoint, BYOK, runtime config; `@openrouter/ai-sdk-provider` = the bundled OpenRouter preset |
| Handoff | `@ai-sdk/mcp` — `createMCPClient`, Streamable HTTP |
| Validation | Zod 4 — every bus, storage, MCP and model boundary |
| Lint + format | Biome 2 |
| Tests | Vitest 4 (unit + integration) + Playwright 1.61 (E2E on the loaded extension) |
| i18n | `@wxt-dev/i18n` — `src/locales/en.yml` |
| Crash telemetry | `@sentry/browser` — error events only |

Reference: `docs/reference/agent-sdk.md`.

## Commands

### One-command scripts

| | |
|--|--|
| `bin/setup` | `bun install` + Playwright Chromium (`--with-deps`) |
| `bin/dev` | WXT dev (HMR) with a private `XDG_CONFIG_HOME` — `mktemp -d`, removed on exit |
| `bin/check` | `bun run verify` (lint + typecheck + unit + integration) |
| `bin/stop` | Stub — nothing to stop yet (no compose file at the repo root); exits 0 |

### bun scripts

| | |
|--|--|
| `bun run dev` | WXT dev, HMR (`dev:firefox` for Firefox) |
| `bun run build` | Build → `build/chrome-mv3` (`build:firefox`) |
| `bun run release` | Build + zip, minified, tree-shaken |
| `bun run local` | Install/prepare, build, print the load-unpacked path (`--firefox`, `--check`, `--zip`) |
| `bun run typecheck` | tsgo (`typecheck:tsc` = stock tsc) |
| `bun run lint` | Biome check (`lint:fix`, `format`) |
| `bun run test` | Unit + integration (`test:unit`, `test:integration`, `test:watch`, `test:changed`, `test:coverage`) |
| `bun run test:e2e` | Playwright against the loaded extension — build first |
| `bun run verify` | Lint + typecheck + unit + integration |
| `bun run check` | Lint + typecheck, concurrent — no tests |
| `bun run gate` | `verify` + build + E2E |
| `bun run debug:live` | Real Chromium + the BUILT extension: configures the provider through the real Settings UI with the key from `.env`, runs a real turn, prints the SW/panel/page consoles + a per-turn trace (tools, latency, token spend). Flags: `--say`, `--url`, `--model`, `--overlay`, `--repeat N`, `--no-turn` (spends nothing), `--headed`. See `.env.example` |

### just recipes

`just setup` · `dev` · `dev-firefox` · `build` · `release` · `verify` · `check` · `gate` · `local` · `lint` · `fix` · `typecheck` · `test` · `e2e` · `clean`

### CI

`.github/workflows/ci.yml` jobs: `lint` · `typecheck` · `test` (unit + integration, one pool) · `build` (needs lint+typecheck) · `test-e2e` (needs lint+typecheck) · `actionlint`.

- Markdown-only PRs skip CI — `paths-ignore` skips when EVERY changed file matches (`**/*.md`, `docs/**`, `site/**`, `waitlist/**`).
- E2E runs headless in CI — the `chromium` channel is the full Chrome-for-Testing build (`chrome-headless-shell` cannot load an unpacked extension), so no xvfb is needed; CI is where headless Chromium actually runs; the Windows dev box cannot complete Playwright's launch handshake under Bun's node-shim.
- Parallelism: locally vitest caps `maxWorkers` at 2 (`vitest.config.ts`) and Playwright at 2 workers (`playwright.config.ts`); CI leaves vitest uncapped and asks Playwright for 50% of cores. Override with `DZ_TEST_WORKERS` / `DZ_E2E_WORKERS`.

## Structure

| Path | World | Responsibility |
|------|-------|----------------|
| `src/agent/` | SW | Loop (`ToolLoopAgent`), provider + config store, key custody, readiness, modes, session, budget, history store, system prompt |
| `src/agent/tools/` | SW | Tool surface — `src/agent/tools/dom.ts`, `src/agent/tools/browse.ts`, `src/agent/tools/tabs.ts`, `src/agent/tools/describe.ts`, `src/agent/tools/identity.ts`, `src/agent/tools/interact.ts`, `src/agent/tools/responsive.ts`, `src/agent/tools/complex-site.ts`, `src/agent/tools/resources.ts`, `src/agent/tools/session.ts`, `src/agent/tools/vision.ts`, `src/agent/tools/provider-schema.ts` |
| `src/agent/browser-control.ts` | SW | CDP-backed browser control (navigate, click, type, scroll, wait) |
| `src/agent/device-driver.ts` | SW | Device emulation driver over `chrome.debugger` |
| `src/agent/device-emulation.ts` | SW | Emulation decision logic — preset resolution, CDP-vs-fallback pick, breakpoint sweep, restore |
| `src/agent/emulation-registry.ts` | SW | Emulation registry — owner-scoped teardown state, persisted in `chrome.storage.session` |
| `src/agent/vision.ts` | SW | Vision sub-call — capture a region, ask the vision model, return the verdict |
| `src/agent/vision-evict.ts` | SW | Image eviction — step-age eviction of screenshot payloads from the in-flight transcript |
| `src/agent/attachments.ts` | SW | Folds user attachments into a turn as image/text parts |
| `src/dom/` | Content | Read/mutate primitives, selector engine, picker overlay, recorder, diagnostics (viewport/scroll/perf), identity/describe, charts/widget recipes, responsive scanner |
| `src/dom/page-ops/` | Content | Bundled page operations behind one bus message — `src/dom/page-ops/design-system.ts`, `src/dom/page-ops/forms.ts`, `src/dom/page-ops/geometry.ts`, `src/dom/page-ops/motion.ts`, `src/dom/page-ops/index.ts` |
| `src/dom/quiescence.ts` | Content | Mutation quiescence — waits for the page to settle |
| `src/dom/structural-bulk.ts` | Content | One structural op applied to many targets |
| `src/dom/execute.ts` | Content | The mutation executor |
| `src/dom/images.ts` | Content | Image handling for DOM reads |
| `src/dom/framework-hints.ts` | Content | Framework detection → source-location hints for the handoff |
| `src/mcp/` | SW | Client + manager, auth (API key / OAuth+PKCE), server store, handoff routing (MCP task or MD-report fallback) |
| `src/mcp/backend.ts` | SW | Backend registry + the `task` dispatch verb |
| `src/mcp/design-gate.ts` | SW | Write-tool gate for design turns (name-based; MCP annotations untrusted) |
| `src/mcp/tool-grants.ts` | SW | Durable per-server, per-tool opt-in grants |
| `src/changeset/` | SW | Store (undo/redo), Markdown renderers, pending-mutation persistence, panel ops |
| `src/changeset/report-md.ts` | SW | Markdown renderer — the agent-authored report |
| `src/changeset/changeset-md.ts` | SW | Markdown renderer — the changeset itself |
| `src/changeset/panel-ops.ts` | SW | Panel-driven curation of the durable changeset |
| `src/changeset/pending-mutations.ts` | SW | Mutations buffered before they are recorded |
| `src/changeset/pending-persist.ts` | SW | Persistence of the pending set across a worker restart |
| `src/shared/` | all | Zod schemas (messages, changeset, report, overlay) + port/relay plumbing — `src/shared/attachments.ts`, `src/shared/page-ops.ts`, `src/shared/host-permissions.ts`, `src/shared/diagnostics.ts`, `src/shared/links.ts`, `src/shared/sentry.ts`, `src/shared/onboarding-prefs.ts`, `src/shared/overlay-prefs.ts` |
| `src/entrypoints/background.ts` | SW | Loop bootstrap, message-bus host, overlay-step relay, session restore |
| `src/entrypoints/content.ts` | Content | DOM bridge (isolated), picker mount, overlay mount, recorder relay |
| `src/entrypoints/injected.content.ts` | MAIN | Page-facts + chart-lib bridge + page-ops. **No secrets, ever** — the page's own untrusted world. `pageCall` invokes page-owned functions by path, never by code string: no `eval`/`new Function`/`<script>`; path guard + identity check against aliased `eval`/`Function`; hostile-page-safe result marshalling |
| `src/entrypoints/image-worker.ts` | Panel | Off-main-thread image encoder — a WXT unlisted script, spawned classic-worker style |
| `src/entrypoints/sidepanel/` | Panel | Solid SPA (chat, MCP, history, settings) |
| `src/entrypoints/sidepanel/stores/` | Panel | Thin stores — chat, session, mcp, readiness, settings, history, changeset, overlay, onboarding, nav, focus, attachments, bus, debug-log, sw-stream |
| `src/entrypoints/sidepanel/lib/` | Panel | Image encode — `src/entrypoints/sidepanel/lib/image-encode.ts`, `src/entrypoints/sidepanel/lib/image-encode-client.ts`, `src/entrypoints/sidepanel/lib/image-encode-protocol.ts` |
| `src/entrypoints/sidepanel/components/Icon.tsx` | Panel | Icon component (inline SVG, tree-shaken, no innerHTML-of-remote) — no remote fetch, CSP-clean |
| `src/styles/` | Panel | `src/styles/_tokens.scss` (design tokens), `src/styles/_mixins.scss`, `src/styles/_functions.scss` |
| `src/locales/en.yml` | all | Every i18n string |

## Conventions

### MV3 three worlds

- **Service worker** — keys, network, MCP tokens, `chrome.*`. `src/entrypoints/background.ts`.
- **Content script** — the DOM. Isolated world. `src/entrypoints/content.ts`.
- **Side panel** — the UI. Own origin, CSP-clean. `src/entrypoints/sidepanel/`.
- **MAIN world** — the page's own, untrusted world (`src/entrypoints/injected.content.ts`). Page content in, no secrets out.
- Cross-world traffic: Zod-validated in `src/shared/`, typed bus, no `any`.
- No remote code, no `eval` — Solid is prebuilt to static JS.
- Permissions least-privilege; `<all_urls>` stays in `optional_host_permissions` (`wxt.config.ts`).

### SolidJS + SRP

- One component = one TSX file + co-located SCSS file. Same basename.
- One module = one responsibility. Small files. Split when a file does two things.
- No business logic in components. Components render + dispatch only.
- State via signals/stores (`createSignal`, `createStore`) — never prop-drill more than one level; lift to a store.
- Derive with `createMemo`; side effects in `createEffect`. No manual DOM in components.
- UI copy from `src/locales/en.yml` — never a hardcoded string in a component. Live exception: `src/entrypoints/sidepanel/components/UsageMeter.tsx` ("Usage", "step"/"steps", "tokens").

### SCSS

- Co-located with the component. Scope to a root class (`.chat-panel { ... }`); BEM-ish for children.
- Tokens (colors, spacing, radius) in `src/styles/_tokens.scss`. NEVER hardcode a hex/px that's a token.
- Shared mixins in `src/styles/_mixins.scss`.

## Readiness + Start

`computeReadiness()` (`src/agent/readiness.ts`) → `ready = provider ok && model ok && apiKey !== 'missing'`.

| Row | Gates Start |
|-----|-------------|
| provider | yes |
| model | yes |
| apiKey | yes, unless the endpoint is local → `not-required` |
| hostPermission (provider origin) | no — advisory |
| pageAccess (`<all_urls>`) | no — advisory; gates the vision tools |
| mcp | no — advisory |

UI: `ReadinessDropdown` — a status pill expanding into the six rows, each with a Fix deep-link (page access offers an in-place Grant instead). User clicks Start → the loop boots; Stop aborts the in-flight turn.

Mode: `'copy' | 'debug'` (`src/shared/messages.ts`). Explicit `UserMessage.mode` wins; else inferred from the message text (`src/agent/modes.ts`); else the session's previous mode; else the turn runs with no mode addendum. No mode picker UI. Browse is a tool, not a mode.

Ship routes to an MCP task (backend connected) or a Markdown report download (fallback — a Markdown file to the download folder).

## Outputs

- **Live edits** → changeset (undo/redo) + agent-authored report (identity + findings)
- **On Ship** → MCP task to ai-dev/backend (if connected) → real PR in ~minutes; OR a Markdown download (standalone usage, paste into a coding agent)
- **History** → last 10 sessions + reports (ring buffer, `chrome.storage.local`)

## Before a PR

- `bun run verify` clean (lint + typecheck + unit + integration).
- New module → add a unit test. New cross-world flow → add an integration test.

## Pointers

| Where | What |
|-------|------|
| `docs/idea/principles.md` | The non-negotiables a change is weighed against |
| `docs/idea/ai-first.md` | How work is done here — layers, skills, compressed config |
| `docs/idea/agent.md` | Provider, readiness, modes |
| `docs/idea/live-edit.md` | The live-edit engine |
| `docs/idea/handoff.md` | Ship / report |
| `docs/idea/mcp.md` | MCP servers + auth |
| `docs/idea/testing.md` | Test strategy |
| `docs/idea/ui.md` | Panel UI |
| `docs/architecture/` | Decisions, security, worlds, changeset, handoff |
| `docs/architecture/adr/` | Decision records |
| `docs/reference/agent-sdk.md` | AI SDK 7 provider + tool-loop reference |
| `docs/wiki/` | User-facing guide |
| `docs/RELEASING.md` | Cutting a release |
| `.claude/skills/live-edit/SKILL.md` | DOM mutation primitives, picker, selector heuristics |
| `.claude/skills/mv3/SKILL.md` | MV3 gotchas — worlds, CSP, ephemeral worker, bus |
| `.claude/skills/ship/SKILL.md` | Changeset → MCP handoff |
| `.claude/skills/solid-srp/SKILL.md` | One component per file, thin stores |
| `.claude/skills/test-extension/SKILL.md` | Vitest + Playwright patterns |
| `.claude/agents/extension-reviewer.md` | Review checklist |
| `.claude/commands/` | Repeated flows (`feature`, `planx`, `scaffold-tool`, `verify`) |
| `AGENTS.md` | Pointer to this file — never a second copy |

House style for docs/config: lead with the rule, fragments over sentences, tables for structured data, `MUST`/`NEVER` for hard rules, no meta-framing — `docs/idea/ai-first.md` (compressed config).

## Note

Do not use git worktrees — work directly in this checkout. If a task is big enough to need subagents, run them as a team in this same checkout: split the work into disjoint pieces so no two agents touch the same files.
