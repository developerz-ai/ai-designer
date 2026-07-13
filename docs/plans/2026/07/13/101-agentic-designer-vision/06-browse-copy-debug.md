# 06 — Browse tool + copy-site / debug-site modes

> Part of [`overview.md`](overview.md). Depends on: 04 (loop + tools), 05 (DOM real). World: **service worker** (agent + browse) + **content script** (snapshot injected). Spec: `docs/idea/agent.md`, `.codegraph/vision.txt`.

## Why
The two headline use cases. **Copy site**: (a) no site — "look at nvidia, build ideas"; (b) have site — "make my site like nvidia" (agent visits mine, then nvidia, returns ideas). **Debug site**: user + agent navigate to debug features; agent shouldn't stay in the user's way. Both need a **cross-site browse** capability + mode-specific system prompts.

## Files to change
- `src/agent/tools/browse.ts` — **new**. `browse(url)` tool: open the reference site and snapshot it without hijacking the user's tab. **Decision (see overview Risks)** — recommended: SW opens a background/inactive tab (`chrome.tabs.create({ active:false })`) or reuses a hidden context, injects the content script, runs `a11ySnapshot`/`screenshot`/`getStyles` there, closes it. Requires `optional_host_permissions` grant for the target origin (request at call time; surface denial to chat). Returns a structured "design read": palette, type scale, layout regions, key components.
- `src/agent/modes.ts` — **new**. `Mode = 'copy' | 'debug'`; picks the system-prompt addendum (`04` `system-prompt.ts`) + which tools are emphasized. Copy: browse ref + read own page + propose edits/ideas. Debug: diagnostics-first (console/network/a11y/broken-interaction), propose fixes.
- `src/agent/diagnostics.ts` — **new** (SW-orchestrated, content-executed). The **debug engine** — the agent genuinely *debugs*, not just lints. Collect + correlate a broad problem catalog, then **reproduce** the failure by driving the page (13) and **confirm** with vision (13/14):
  - **Runtime**: console errors/warnings, uncaught exceptions, unhandled promise rejections, CSP violations.
  - **Network**: failed/4xx/5xx requests, slow/hanging calls, CORS failures, broken assets.
  - **Interaction/functional**: dead buttons/handlers, forms that don't submit, broken widgets (datetime picker/combobox/modal — 15), broken client-side routes (SPA — 15), stuck loading states.
  - **A11y**: role/name/contrast/focus-order/keyboard-trap violations.
  - **Layout/visual**: overflow, CLS, z-index/overlap, **responsive breakage (16)**, broken/oversize images (13).
  - **State/data**: empty/error states, stale data, hydration mismatch (15).
  - Method: **observe → hypothesize → reproduce (click/type/wait, 13) → capture (screenshot/console/network) → confirm → propose fix** with a root-cause note. Content-side collectors emit `ContentToSw`; SW aggregates + correlates into a report input (feeds `07`), each finding with repro steps + evidence (screenshot/log links).
- `src/dom/diagnostics-collector.ts` — **new** (content). Console/error/network hooks (page-world-safe), a11y scan; feeds `diagnostics.ts`.
- `src/shared/messages.ts` — add `browse`/`diagnostics` DomTool + result schemas; `Mode` on `UserMessage` (or infer from intent). Add `ContentToSw` diagnostics events.
- `src/entrypoints/content.ts` — init diagnostics collectors; handle `browse`-injected snapshot requests.
- `src/entrypoints/background.ts` — `browse` tab lifecycle (create inactive → inject → snapshot → close); permission request per target origin.
- `src/entrypoints/sidepanel/components/ChatPanel` (see 11) — mode is implicit from the prompt; optionally a small Copy/Debug affordance in the composer. No back-and-forth: one instruction → agent works.

## Steps
1. `browse.ts`: implement the background-tab snapshot; return a compact design-read (bounded token size).
2. `modes.ts` + prompt addenda: copy vs debug behavior; emphasize "agent does the work, asks only when ambiguous" (`agent.md:34`).
3. `diagnostics-collector.ts` (content) + `diagnostics.ts` (SW aggregation) for debug mode.
4. Wire schemas + SW/content handlers; per-origin permission on browse.
5. Copy-with-own-site: agent sequences `browse(mySite)` → `browse(refSite)` → diff → proposes edits on the live page (05) → records to changeset (07).
6. Debug: agent collects diagnostics, navigates with the user (doesn't seize the tab), proposes fixes → report or MCP task (07).

## Tests
- Unit: `modes` prompt selection; `browse` design-read shape (mock snapshot); `diagnostics` aggregation from mock events.
- Integration: `browse(url)` → background tab lifecycle mocked → structured read returned; diagnostics events → aggregated report input.
- E2E: copy flow against two local fixture pages (ref + own) → agent produces recorded ideas/edits; debug flow surfaces a seeded console error → proposed fix.
- `bun run typecheck`, `bun run lint`.

## Done when
- Agent can visit a reference site (with granted permission) and return a usable design-read without hijacking the user's tab.
- Copy-site (with/without own site) and debug-site modes drive distinct, autonomous multi-step behavior.
- Debug mode captures real diagnostics that feed a report/handoff. Gate green.
