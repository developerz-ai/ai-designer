# Agentic Designer Vision — Onboarding → Chat → Ship/Report

## Goal
Turn the scaffold into the product: settings-first onboarding (openai-compatible LLM + custom MCP servers), a readiness dropdown + **Start**, a Leo-style **agentic** chat that copies/debugs sites, and lands work either via MCP handoff or a downloadable MD report — with last-10 conversation history and an optional on-page agent-decision overlay.

## Context
- **Stack**: Bun + TS strict, WXT + SolidJS + SCSS, AI SDK 7 `ToolLoopAgent` over an **openai-compatible** provider (BYOK), `@ai-sdk/mcp` handoff, Zod at every boundary. Biome. Vitest + Playwright.
- **Three worlds — load-bearing** (`docs/architecture/mv3-worlds.md`): keys + network + MCP tokens **only** in the service worker (`src/entrypoints/background.ts`); DOM **only** in the content script (`src/entrypoints/content.ts`); UI **only** in the side panel (`src/entrypoints/sidepanel/`). Every cross-world message Zod-validated in `src/shared/messages.ts`. No `any` across the bus. No remote code / `eval` — Solid prebuilt, FontAwesome self-hosted.
- **What exists (reuse, don't rebuild)**: typed Zod bus across all 3 worlds (`src/shared/messages.ts`), SW↔panel Port w/ reconnect (`stores/sw-stream.ts`, `stores/bus.ts`), encrypted key custody (`src/agent/key-store.ts`), stable-selector engine (`src/dom/selector.ts`), working BYOK settings flow (`SettingsPanel.tsx` + `stores/settings.ts`), changeset schema (`src/shared/changeset.ts`), focus/picker plumbing (`stores/focus.ts`, `shared/relay.ts`).
- **What's stub/absent**: agent loop, DOM execution, MCP client, readiness/Start, history, reports, overlay, multi-provider config. `background.ts` `user-message`/`ship` are TODOs; `content.ts` `exec()` all stubbed.
- **Reference UI**: Brave **Leo** side-panel chat — header actions, inline model selector, page-context chip above input, suggestion chips, settings gear. Screenshots in `.codegraph/*.png`. **Copy Leo's polish, but build it for web developers _and_ vibecoders** — task-shaped suggestions, dev-legible tool chips, one-click brief/handoff, visible agent reasoning so non-experts trust it.
- **Session control**: a **Start/Stop toggle** (readiness `03`) turns the session on/off and aborts an in-flight agent turn.
- **Output is a developer brief**: Download/Send triggers an **agent-authored** review (colors, fonts, layout, problems, pros/cons, links, images), not a raw dump; with a coding MCP connected the agent may **decompose findings into multiple tasks**, one `task(create)` per problem (`07`).
- **SRP mandate** (`docs/idea/principles.md`, CLAUDE.md): one component = one `.tsx` + co-located `.scss`; **no business logic in components** (logic in `src/agent`/`src/dom`/`src/mcp`/`src/changeset`); state in thin signals/stores; SCSS scoped to a root class, tokens from `src/styles/_tokens.scss`.

## Plan files (execute in order)
1. [`01-provider-config.md`](01-provider-config.md) — generalize OpenRouter-only → openai-compatible provider (baseURL + key + model); settings schema + UI.
2. [`02-mcp-servers.md`](02-mcp-servers.md) — `src/mcp` client mgmt; add/remove custom servers; OAuth-PKCE + API-key auth; McpPanel + AuthDialog.
3. [`03-readiness-start.md`](03-readiness-start.md) — readiness store (provider+model+mcp+host-perm) → "ready" dropdown + **Start** gate.
4. [`04-agent-loop.md`](04-agent-loop.md) — `ToolLoopAgent` in the SW; system prompts; DomTool→`tool()` derivation; stream tokens/tool-calls to panel; budgets + session resume.
5. [`05-dom-tools-content.md`](05-dom-tools-content.md) — real DOM execution + mutator + picker overlay + recorder in the content script; wire `relay.ts` TODOs.
6. [`06-browse-copy-debug.md`](06-browse-copy-debug.md) — cross-site browse tool + copy-site / debug-site agent modes + diagnostics capture.
7. [`07-handoff-and-report.md`](07-handoff-and-report.md) — Ship via MCP `task(create)` **or** downloadable concise MD report (`src/changeset` report gen).
8. [`08-history.md`](08-history.md) — persist last-10 conversations + reports; History UI (SPA).
9. [`09-agent-overlay.md`](09-agent-overlay.md) — opt-in on-page overlay showing agent decisions live.
10. [`10-fontawesome-ui-system.md`](10-fontawesome-ui-system.md) — self-hosted FontAwesome (CSP-clean), `Icon.tsx`, token/mixin additions.
11. [`11-chat-ui-leo.md`](11-chat-ui-leo.md) — Leo-style ChatPanel redesign: header actions, inline model picker, context chip, suggestions, tool chips, streaming.
12. [`12-docs-wiki-claude-md.md`](12-docs-wiki-claude-md.md) — update `docs/idea` + `docs/architecture`, new `docs/wiki/` guide, refresh CLAUDE.md.
13. [`13-browser-control-vision.md`](13-browser-control-vision.md) — the agent really **controls the browser**: navigate/click/type/scroll/wait/tabs + full-page screenshots + image checks; **iframe- and multi-tab-aware** (`{tabId, frameId}` on every tool).
14. [`14-describe-identity.md`](14-describe-identity.md) — `describe` a page/region/image **in text** + `extractIdentity` (color palette / type scale) so copy reuses a site's identity and reports read in tokens.
15. [`15-complex-sites-spa-widgets-charts.md`](15-complex-sites-spa-widgets-charts.md) — robustness on real apps: SPA/hydration awaiting, **shadow-DOM widgets** (datetime pickers, comboboxes), virtualized lists, **canvas/WebGL charts read via vision + a guarded page-world data probe**.
16. [`16-responsive-mobile.md`](16-responsive-mobile.md) — **check how the site looks on mobile**: device emulation (CDP), multi-breakpoint capture, responsive problem detection.

## Done when
- Fresh install opens Settings; user configures an openai-compatible provider + model and (optionally) a custom MCP server with OAuth or API-key auth.
- Readiness dropdown reports **ready**; **Start** enters chat.
- A single instruction ("copy nvidia's hero", "debug this broken filter") runs a **multi-step** agent turn (not one edit), streaming tokens + tool-call chips into a Leo-style panel; optional overlay shows decisions on-page.
- Result lands as an MCP task→PR **when a coding backend is connected**, otherwise as a downloadable concise MD report.
- Last 10 conversations + their reports are browsable.
- `bun run lint` + `bun run typecheck` clean; unit + integration + relevant E2E green.
- Docs (`docs/idea`, `docs/architecture`), a new `docs/wiki/` guide, and CLAUDE.md reflect the shipped behavior.

## Risks / open questions
- **Key custody**: openai-compatible key + MCP OAuth/API tokens live encrypted in `chrome.storage.local`, decrypted **only** in the SW. Generalize `key-store.ts` to multiple named secrets — never leak baseURL creds to content/page.
- **Host permissions**: arbitrary openai-compatible endpoints + arbitrary MCP servers + arbitrary sites-to-copy all need runtime `optional_host_permissions` grants (`<all_urls>` already optional). Request per-origin at connect/first-use, don't broaden static host_permissions.
- **Cross-site browse** ("go look at nvidia"): decide the mechanism — a background `chrome.tabs` fetch/snapshot vs opening a real tab and injecting the content script. Affects perms + CSP. See `06`.
- **Real browser control across frames/tabs** (`13`): content scripts are **per-frame** — need `all_frames: true` + `webNavigation` to enumerate frames, and every tool must carry a `{ tabId, frameId }` target. Cross-origin iframes can't be reached from the parent — address each via its own injected frame script. Multi-tab copy (own tab + reference tab) means the SW owns a tab/frame registry.
- **Complex sites** (`15`): shadow DOM (`selector.ts` can't pierce it today), canvas/WebGL charts (no DOM — vision + a **page-world (MAIN) bridge** that must never carry secrets), SPA hydration timing. Closed shadow roots / canvas fall back to vision + coordinates, flagged fragile.
- **Device emulation** (`16`): true mobile emulation (DPR/touch/UA) wants the `chrome.debugger` permission + shows a "being debugged" banner — surface it; a viewport-resize fallback approximates when the user declines.
- **Debugging is a first-class mode** (`06`): observe → reproduce (drive the page) → confirm (vision) → root-cause + fix, across runtime/network/interaction/a11y/layout/responsive/state — not just console-error listing.
- **MCP transport/auth**: follow `modelcontextprotocol.io/specification/2025-03-26/basic/transports` (Streamable HTTP; SSE deprecated). PKCE required for public clients; `chrome.identity.launchWebAuthFlow`.
- **Agent autonomy vs human-in-loop**: agent drives multi-step, but **Ship is never automatic** (`toolApproval` gate). Overlay + step budget keep it observable/bounded.
- **SW eviction mid-turn**: persist in-flight run + changeset to `chrome.storage.session`, resume on wake (`agent-loop.md`, `mv3-worlds.md`).
