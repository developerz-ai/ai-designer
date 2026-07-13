# 03 — Readiness dropdown + Start/Stop toggle

> Part of [`overview.md`](overview.md). Depends on: 01, 02. World: **side panel** (derives), **service worker** (truth). 

## Why
Vision: "i open the dropdown, says that's ready. press start." + "start stop button (to toggle it on/off)". No readiness concept today. A single derived state gates chat entry and tells the user what's missing; a **Start/Stop toggle** turns the session on/off and **stops an in-flight agent run**.

## Files to change
- `src/shared/messages.ts` — add RPC `readiness` → `ReadinessState` = `{ provider: ok|missing, model: ok|missing, hostPermission: granted|needed, mcp: {connected:number, total:number}, ready: boolean }`. Add `session-start` + `session-stop` PanelToSw msgs (stop also **aborts an in-flight agent turn** — 04). Add a `session-state` `SwToPanel` event (`idle|running|stopped`).
- `src/agent/readiness.ts` — **new** (SW). Compute `ReadinessState` from `config-store` (01) + `McpManager` (02) + `chrome.permissions`. `ready = provider && model` (MCP optional — copy/debug can still produce a report per `06`/`07`).
- `src/entrypoints/background.ts` — handle `readiness` RPC + `session-start` (marks session active, primes agent — see `04`).
- `src/entrypoints/sidepanel/stores/readiness.ts` — **new**. Thin store; refetch on settings/mcp change (subscribe to stream).
- `src/entrypoints/sidepanel/components/ReadinessDropdown.tsx` + `.scss` — **new**. Leo-style status pill in the panel header: collapsed shows "Ready ✓" / "Setup needed" / "Running…"; expanded lists each check w/ FontAwesome status icon + deep-link to the relevant Settings/MCP tab. Contains the **Start/Stop toggle** (Start enabled only when `ready`; while a turn runs it becomes **Stop** → sends `session-stop` to abort; toggling the session off returns to the pre-Start state).
- `src/entrypoints/sidepanel/App.tsx:15-64` — render `ReadinessDropdown` in the header; gate `ChatPanel` behind `session-started` (before Start: show readiness/empty state; after: chat). Keep tab shell.

## Steps
1. `messages.ts`: `ReadinessState` + `readiness`/`session-start`.
2. `readiness.ts` (SW): pure-ish compute from stores; expose over RPC; push updates on config/mcp change via `SwToPanel`.
3. `readiness` store + `ReadinessDropdown` component (SRP — render + dispatch).
4. `App.tsx`: header slot + start-gating (a `sessionStarted` signal; Start sends `session-start`, flips to chat).
5. Each unmet check links to its fix (Settings/MCP tab switch).

## Tests
- Unit: `readiness.ts` truth table — provider missing / model missing / no host perm / mcp 0-of-N → correct `ready` + per-check flags. `ReadinessState` schema.
- Integration: settings change → readiness RPC reflects new state through the bus.
- E2E: fresh profile → dropdown "Setup needed" + Start disabled; after configuring provider+model (stubbed) → "Ready" + Start enabled → click Start → chat visible.
- `bun run typecheck`, `bun run lint`.

## Done when
- Header dropdown accurately reports readiness and what's missing, each check deep-links to its fix.
- **Start** disabled until ready; clicking it opens chat and primes the session.
- The toggle flips to **Stop** during a run and aborts the in-flight agent turn cleanly; toggling the session off returns to the pre-Start state. `session-state` reflects `idle|running|stopped`. Gate green.
