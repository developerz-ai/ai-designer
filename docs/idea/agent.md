# Agent

The design agent. A [Vercel AI SDK](https://github.com/vercel/ai) `ToolLoopAgent` running in the extension's service worker, talking to **any OpenAI-compatible `/v1` endpoint** (OpenRouter is a bundled preset, not a hardcoded dependency), driving DOM tools to edit the live page. Named "Leo" in the UI.

## Provider — BYOK, any endpoint

- `createProvider(cfg)` builds an AI SDK model from `ProviderConfig = { baseURL, apiKey?, model, label? }` via `createOpenAICompatible` (`src/agent/provider.ts`) — OpenRouter's `https://openrouter.ai/api/v1` is one preset among many; self-hosted/local/other-vendor `/v1` endpoints work the same way.
- `listModels()` fetches `{baseURL}/models` for the in-panel model picker; `validateProvider()` pings the same endpoint to confirm the key/URL before unlocking Start (see [readiness](#readiness--start), `src/agent/readiness.ts`).
- Key custody: non-secret fields (`baseURL`, `model`, `label`) live plaintext in `chrome.storage.local`; `apiKey` is AES-GCM-encrypted by `src/agent/key-store.ts` under a non-extractable WebCrypto key, stored as `provider:default:key`. Never touches the content script.
- A legacy OpenRouter-only install migrates automatically on first SW start (`src/agent/config-store.ts`).

## Readiness / Start

The header shows a status pill ("Setup needed" → "Ready" → "Running…") that expands into a checklist: **Provider**, **Model**, **Host permission**, **MCP backend** (informational, not blocking) — each row deep-links to Settings or the MCP tab to fix it. `computeReadiness()` (`src/agent/readiness.ts`) is `ready = provider ok && model ok`; **MCP is optional** — copy/debug flows work with zero connected servers, falling back to a downloadable report (see [handoff.md](handoff.md)). Start/Stop is a separate toggle, disabled until `ready`.

## Loop — autonomous, multi-step

One instruction kicks off an **agentic run of many tool-call steps**, not a chat turn with one edit. The agent reads, mutates, *looks at its own result*, refines, and repeats until the goal is met — then records. This is `agent.stream({ messages, abortSignal, onStepFinish })` on a `ToolLoopAgent` (`src/agent/loop.ts`), not a plain request/response.

```
user msg ─► ToolLoopAgent.stream({ tools, instructions })
              │  loops on its own, step after step, bounded by TurnBudget:
              ├─ query / a11ySnapshot      (find + understand the target)
              ├─ screenshot / describe      (see or read the current state)
              ├─ setStyle / setText / ...   (mutate the live page)
              ├─ screenshot                 (verify — did it look right?)
              ├─ setStyle (correct)         (adjust based on what it saw)
              ├─ ...repeat until satisfied...
              └─ recordEdit(intent)         (finalize to the changeset)
```

Worked example — *"make the hero full-bleed and the CTA pop"* runs as **one** turn:

1. `query` the hero + CTA → resolve stable selectors
2. `screenshot` → baseline
3. `setStyle` hero `max-width: none; padding-inline: 0`
4. `screenshot` → sees the hero is now edge-to-edge but text hugs the border
5. `setStyle` hero inner `padding-inline: 4rem` (self-correction)
6. `setStyle` CTA `background / padding / font-size`
7. `screenshot` → confirms contrast + size
8. `recordEdit("full-bleed hero + prominent CTA")`

- Tools are the only way the agent touches the page — it has no direct DOM handle (it's in the service worker).
- Vision-capable models receive screenshots, so the agent *sees* its own work and self-corrects mid-run.
- It only stops to **ask** when genuinely ambiguous; otherwise it drives to a result, then reports what it did.
- If the on-page overlay is enabled, each step is mirrored live to the page as it happens (see [ui.md](ui.md#overlay)).

## Modes — copy, debug (`src/agent/modes.ts`)

The composer can pin an explicit mode, or the agent infers one from the instruction text. A mode appends an addendum to the system prompt and gives a suggested tool-emphasis order — **it never restricts the tool set**, every tool stays available.

| Mode | What it does | Emphasized tools |
|------|---------------|-------------------|
| `copy` | `browse` the reference site first (background tab), `extractIdentity` its palette/type/spacing, apply that identity to the user's page, check responsive breakpoints. | `browse`, `extractIdentity`, `describe`, `query`, `getStyles`, `a11ySnapshot`, `setStyle`, `setText`, `setDevice` |
| `debug` | `diagnostics` first (drain buffered console/network signals, scan a11y/layout), then observe → hypothesize → reproduce → capture → confirm → root-cause → fix, covering responsive breakage too. | `diagnostics`, `a11ySnapshot`, `getStyles`, `screenshot`, `query`, `setDevice`, `checkResponsive` |

No mode = plain design chat, full tool catalog, no addendum.

## Browse — reading a reference site

`browse` opens **another** URL in an inactive background tab (never hijacks the user's own tab), waits for load, snapshots its design read, and always closes the tab — even on failure (`src/agent/browse-tab.ts`). It's the first step of copy mode, but usable standalone: "what does stripe.com's pricing page look like?" `tabs` / `frames` (`src/agent/tools/tabs.ts`) are the general-purpose multi-tab/iframe primitives `browse` is built on.

## Inference budgets

| Guard | Mechanism |
|-------|-----------|
| Runaway loop | `TurnBudget.maxSteps` (24) via `stopWhen` |
| Token spend | `TurnBudget.maxTokens` (200k); stop + summarize rather than loop forever |
| Vision cost | `maxVisionCalls` (6) — caps `screenshot`/`inspectVisually`/`responsiveCapture` per turn |
| Page waits / navigation | `maxWaitCalls` (10), `maxNavCalls` (8) — fails just that tool call, not the turn |
| Destructive surprise | mutations reversible + previewed; user accepts before ship |
| Auto-ship | none — `handoff` is user-triggered only (see [handoff.md](handoff.md)) |

## Tool catalog

One AI SDK tool set per module under `src/agent/tools/`, merged by `buildTools()` (`src/agent/loop.ts`):

| Module | Tools | Purpose |
|--------|-------|---------|
| `dom.ts` | `query`, `getStyles`, `setStyle`, `setText`, `a11ySnapshot`, `undo`, `screenshot` | Core page read/mutate — 1:1 with `DomTool` |
| `interact.ts` | `click`, `type`, `pressKey`, `hover`, `scrollTo`, `selectOption`, `waitFor`, dialog handling, `navigate`/`back`/`reload` | Drive the page like a user |
| `tabs.ts` | `tabs`, `frames` | Multi-tab + iframe enumeration, addressable `{tabId, frameId}` |
| `vision.ts` | `screenshot`, `readImages`, `inspectVisually` | Visual capture + broken/oversized-image scan + vision-model self-check |
| `describe.ts` | `describe`, `readImageContent` | Cheap text-first alternative to screenshots (layout/content summary) |
| `identity.ts` | `extractIdentity` | Role-tagged palette/type-scale/spacing extraction — feeds copy mode |
| `responsive.ts` | `setDevice`, `responsiveCapture`, `checkResponsive` | Device emulation, multi-breakpoint capture, mobile-bug scan |
| `complex-site.ts` | `pageFacts`, `readChart`, `chartTooltip`, `widgetAct` | SPA/shadow-DOM/canvas-chart stacks, ARIA-widget recipes |
| `browse.ts` | `browse` | Reference-site read (see above) |
| `session.ts` | `recordEdit`, `undo`, `redo`, `handoff` | Changeset finalize + approval-gated ship |

Full argument/return shapes are the Zod schemas in `src/shared/messages.ts`, grouped by concern (DOM tools, browser-control, vision, complex-site/chart/widget, responsive, MCP/history/readiness).

## Memory

- **Turn context** — `SessionStore` (`src/agent/session.ts`) keeps per-tab message thread + changeset + usage, mirrored to `chrome.storage.session` so it survives service-worker eviction.
- **History** — last 10 conversations (+ their reports/PR links) persisted across sessions. See [ui.md](ui.md#history).
- **Page facts** — framework/chart-lib/runtime stack detected via the MAIN-world bridge, cached per URL for the session.

## Guardrails

- Mutations are reversible and previewed — no destructive surprise.
- Agent never calls `handoff` on its own; the user clicks Ship (or Download).
- Step/token/vision/nav budgets per turn; stop and summarize rather than loop.
- Selector fragility surfaced to the user before recording.

## MCP tools at design time (optional)

If a connected MCP backend exposes read tools (e.g. ai-dev's `kb` / repo search), the agent can *consult* them while designing — "what design tokens does this repo define?" — so its edits already speak the codebase's language. Handoff then carries less guesswork. See [mcp.md](mcp.md).

## Reference

Current SDK API (AI SDK 7 `ToolLoopAgent`, `createOpenAICompatible` provider, `@ai-sdk/mcp`), code sketches, and version gotchas: [../reference/agent-sdk.md](../reference/agent-sdk.md).
