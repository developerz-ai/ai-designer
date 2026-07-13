# 04 — Agent loop (ToolLoopAgent in the SW)

> Part of [`overview.md`](overview.md). Depends on: 01 (provider), 02 (mcp tools). World: **service worker only** (network + keys). Spec: `docs/idea/agent.md`, `docs/architecture/agent-loop.md`, `docs/reference/agent-sdk.md`. This is the single biggest gap.

## Why
`background.ts:63-66` `user-message` is a TODO; no `ToolLoopAgent`, no tools wired, chat is a local echo (`ChatPanel.tsx:16-23`). Build the autonomous, multi-step loop that streams tokens + tool-calls to the panel. **Agent drives many steps per instruction, not one edit per message** (`agent.md:6-19`).

## Files to change
- `src/agent/tools/dom.ts` — **new**. Derive AI SDK `tool()` 1:1 from the `DomTool` Zod schemas already in `src/shared/messages.ts:98-129` (the schemas were shaped for this). Each `execute` proxies to the content script over the bus (`sendToContentScript`) and returns the typed `ToolResult` (`messages.ts:139-177`). Covers `query`/`getStyles`/`screenshot`/`a11ySnapshot`/`setStyle`/`setText`/`setAttr`/structural mutators.
- `src/agent/tools/session.ts` — **new**. `recordEdit(intent)` (appends to changeset — see `07`), `undo`/`redo`, and `handoff` (static/approval-gated — `07`; never auto-runs, `toolApproval`).
- `src/agent/system-prompt.ts` — **new**. **First-class deliverable — invest here.** A strong designer/senior-web-developer system prompt (persona + operating doctrine), not a one-liner. Base prompt (`agent.md:21-35`) + mode addenda injected by `06` (copy-site / debug-site). Draw on `~/workspace/sebyx07/claude-code-bible` + `../gold-standards-in-ai` prompt patterns. It must cover:
  - **Persona**: acts like a senior web developer + designer — opinionated on color, typography, spacing, hierarchy, a11y, responsive.
  - **Autonomy doctrine**: one instruction → many steps; read→mutate→screenshot→`inspectVisually`→self-correct→record; **do the work, don't ping-pong**; ask only when genuinely ambiguous (`agent.md:34`).
  - **Tool-use policy**: when to `describe`/`extractIdentity` (14) vs screenshot (cost), when to drive the browser / enter iframes / open a reference tab (13), when to consult MCP read tools (design tokens).
  - **Copy vs debug** behaviors; **decompose** big asks into problems (feeds multi-task handoff, 07).
  - **Output/report voice**: colors, fonts, problems, pros/cons — the developer-brief tone (07).
  - **Guardrails**: never ship on its own; respect budget; flag fragile selectors; edits are ephemeral.
  - Keep it maintainable: composed from named sections (persona/doctrine/tools/modes/output/guardrails) so modes/slices append cleanly.
- `src/agent/loop.ts` — **new**. `runTurn({ messages, tabId, signal })`: build provider model (01), assemble `tools = { ...domTools, ...sessionTools, ...mcpManager.toolsFor() }`, `new ToolLoopAgent({ model, instructions, tools, stopWhen: isStepCount(N), toolApproval: { handoff: … }, onStepFinish })`; `agent.stream({ messages })`; forward `result.stream` parts to the panel Port as `SwToPanel` `token`/`tool-call` events. Vision self-correction: feed screenshots back as image parts (`agent-sdk.md:63-66`).
- `src/agent/budget.ts` — **new**. Per-turn step + token cap; on budget → stop + summarize (`agent-loop.md:60-67`).
- `src/agent/session.ts` — **new**. In-flight turn + changeset persisted to `chrome.storage.session` (SW eviction resume — `mv3-worlds.md`); the `sessions` Map at `background.ts:27` becomes real.
- `src/entrypoints/background.ts:63-66` — replace `user-message` TODO: call `loop.runTurn`, stream to the panel; handle abort/stop. Wire `mcpManager` (02) in.
- `src/shared/messages.ts:227-238` — `SwToPanel` already has `token`/`tool-call`/`edit-recorded`/`error` — reuse; add `step-start`/`turn-done`/`awaiting-approval` if needed for the overlay (09) + chat (11).

## Steps
1. `dom.ts`: map each `DomTool` schema → `tool({ inputSchema, outputSchema, execute })`; `execute` = bus round-trip to content (05 makes it real; until then it drives the stubs).
2. `system-prompt.ts` + `budget.ts` + `session.ts`.
3. `loop.ts`: `ToolLoopAgent` per `agent-sdk.md:43-58`; **use `instructions` not `system`, `stopWhen: isStepCount`, `inputSchema`, `toolApproval` on the agent** (v7 gotchas `agent-sdk.md:124-147`). Stream parts → Port.
4. `background.ts`: wire `user-message` → `runTurn`; persist/resume via `session.ts`; stop on new user msg or budget.
5. `session.ts`: on SW wake, rehydrate an interrupted turn's messages + changeset.
6. Leave copy/debug tool additions + browse tool to `06`; leave real DOM to `05`.

## Tests
- Unit: `dom.ts` tool derivation matches schemas (input/output validate); `budget` stop conditions; `system-prompt` mode assembly; `session` persist/rehydrate round-trip (mock `chrome.storage.session`).
- Integration: `user-message` → mocked model emitting a `setStyle` tool-call → bus round-trip → `SwToPanel` `tool-call` + `token` observed; abort mid-turn cancels cleanly. Mock the provider model (no real network).
- E2E (after 05): a real instruction mutates a fixture page and streams chips.
- `bun run typecheck`, `bun run lint`.

## Done when
- One instruction runs a bounded multi-step `ToolLoopAgent` turn in the SW, streaming tokens + tool-call chips to the panel.
- Tools = DOM + session + connected-MCP tools; `handoff` approval-gated (never auto).
- Turn state survives SW eviction. Gate green.
