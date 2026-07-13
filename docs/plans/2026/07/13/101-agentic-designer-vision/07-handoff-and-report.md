# 07 — Handoff (MCP task) OR downloadable MD report

> Part of [`overview.md`](overview.md). Depends on: 02 (mcp), 04 (session tools), 05 (recorder). World: **service worker** (assemble + dispatch + generate) + **side panel** (Ship/Download UI). Spec: `docs/idea/handoff.md`, `docs/architecture/changeset.md`. Skill: `ship`.

## Why
Vision: if a coding-agent MCP is connected → give it the task(s) directly; **if not → generate a concise downloadable MD** the user pastes into their own Claude Code. Today `ship` is a TODO (`background.ts:67-69`); no report path exists. Applies to both copy (edits/ideas) and debug (diagnostics/fixes).

Extra asks (this slice):
- **The report is agent-authored, not a dump.** The Download button (and a chat command) triggers an agent **summarization pass** that writes a **web-developer-style brief**: colors, fonts/typography, layout, **problems**, **pros/cons**, recommendations — with **links + embedded images/screenshots**. Reads like a senior dev's review, not a raw changeset.
- **Send from chat.** In the chat the user can say "send this to developerz.ai / devin / <backend>" → dispatch the brief to that coding agent (rich content: links, images, palette, fonts). A chat-invokable action, not only the Ship button.
- **Multi-problem → multi-task (when MCP connected).** The agent can decompose findings into **several focused problems and create a separate `task(create)` per problem** (inspired by ai-task-master / claude-task-master), each with its own brief — "it needs to see" (uses the vision + describe/identity tools of 13/14 to ground each task).

## Files to change
- `src/changeset/store.ts` — **new**. Own the live `Changeset` (`src/shared/changeset.ts`) per session: `emptyChangeset`/`addEdit` (already helpers `:49-55`), undo/redo, persist to `chrome.storage.session`. Backs `recordEdit`/`undo`/`redo` session tools (04).
- `src/agent/report.ts` — **new**. The **agent summarization pass**: an AI SDK call (reuse the loop's model) that reads the session (changeset + diagnostics + extracted identity from 14 + captured screenshots from 13) and authors a **developer brief** → structured `Report` = `{ summary, identity{colors,fonts,spacing}, findings[], problems[], pros[], cons[], recommendations[], links[], images[] }`. Runs on Download **and** on the chat "make a report" / "send to X" command.
- `src/changeset/report-md.ts` — **new**. `toMarkdown(report)` → concise MD with embedded image links/screenshots + a tokens table (colors/fonts) + problems/pros. Paste-ready for a coding agent.
- `src/mcp/handoff.ts` — **new**. `ship(report | changeset, target)` → connected backend `task(action:'create', { template:'frontend_dev', repo, title, spec })` (`handoff.md:38-56`); stream `task(watch)` status → `SwToPanel` `task-status`. Origin→repo mapping (`mcp.md:16-18`). **Multi-task**: accepts an array of problems → **one `task(create)` per problem**, each with its own focused brief + images; tracks each task's status independently.
- `src/entrypoints/background.ts:67-69` — replace `ship` TODO: **route** — connected coding MCP → `handoff.ship` (single or multi-task); else → `report-md.toMarkdown` returned to the panel for download. A chat command `send-report { target }` dispatches the brief to the named backend. Never auto-ship (user-triggered only, `principles.md`).
- `src/shared/messages.ts` — add `Report` + `download-report` + `send-report` (`{ target }`) msgs/result variants; `ShipRequest` already exists (`:22-62`) — extend with `target` (repo/backend), `mode`, and `problems[]` for multi-task.
- `src/entrypoints/sidepanel/components/ShipBar.tsx` + `.scss` — **new** (or fold into diff-review). Actions: **Ship** (backend connected → task timeline + PR link; multi-task → multiple timelines), **Download report** (always available → agent brief → MD download via blob URL), and **Send to…** (pick a connected backend → dispatch the brief). FontAwesome icons (10).
- `src/entrypoints/sidepanel/components/TaskTimeline.tsx` + `.scss` — **new**. `queued → working → pr_open → ci_green/red` (`handoff.md:63-66`) + PR link.
- `src/entrypoints/sidepanel/stores/changeset.ts` — **new**. `changesetStore` reflecting SW session state (thin).

## Steps
1. `changeset/store.ts`: session-backed changeset + undo/redo; wire to 04 session tools.
2. `agent/report.ts`: the summarization pass → structured `Report` (colors/fonts/problems/pros/cons/links/images); `changeset/report-md.ts`: `Report`→MD with embedded images + tokens table (golden-file test).
3. `mcp/handoff.ts`: single + **multi-task** `task(create)` + `watch` streams; origin→repo map (persist in mcp store).
4. `background.ts ship`/`send-report`: branch connected-backend vs report; multi-task fan-out; approval-gated (`toolApproval.handoff` from 04).
5. UI: `ShipBar` (Ship / Download / Send to…) + `TaskTimeline` (one per task) + `changesetStore`; report download via blob URL (CSP-clean, own origin).
6. Chat command wiring: "make a report" / "send this to <backend>" (11) → `agent/report.ts` → download or `send-report`.
7. History (08) records the produced report/PR link(s).

## Tests
- Unit: `report-md.toMarkdown` golden output for a sample `Report` (deterministic — mock the summarization model); `agent/report` assembles findings/problems/pros from a sample session; `changeset/store` undo/redo; origin→repo mapping; multi-task split (N problems → N task specs).
- Integration: `ship` with a connected mock backend → `task(create)` per problem + `task-status` streamed independently; `ship`/download with **no** backend → MD report returned; `send-report { target }` from chat dispatches to the named backend; changeset persist/rehydrate.
- E2E: run a design turn → Download produces an .md brief (colors/fonts/problems/pros + image links); Ship (mock MCP) shows a timeline per task + PR links; "send to X" from chat routes correctly.
- `bun run typecheck`, `bun run lint`.

## Done when
- Download/Send triggers an **agent-authored** developer brief (colors, fonts, layout, problems, pros/cons, recommendations) with links + embedded images — reads like a senior dev's review.
- With a coding MCP connected, Ship (or a chat "send to <backend>" command) dispatches `task(create)` — **one per identified problem** when decomposed — and streams status → PR links; never automatic.
- With none connected, a concise MD report downloads, ready to paste into a coding agent. Both copy and debug outputs route correctly. Gate green.
