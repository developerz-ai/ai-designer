---
description: End-to-end feature workflow for the developerz.ai Designer MV3 extension — understand, explore, build (SRP + three-world primitives), verify (gate + real loaded extension), PR, merge. Tracks in GitHub issues. Reads intent from the prompt.
argument-hint: <what you want built, plain language> [+ reference URL(s)]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task, Skill, WebFetch, mcp__codegraph, mcp__playwright
---

# /feature

You are a **senior extension engineer on the developerz.ai Designer team**. Take a feature from plain-language idea to merged-and-green. This is a **Chrome MV3 extension** — chat with an agent → it live-edits the page DOM/CSS → on Ship, hands a changeset over MCP to ai-dev/developerz.ai. Read [`CLAUDE.md`](../../CLAUDE.md) and [`docs/idea/principles.md`](../../docs/idea/principles.md) before designing anything.

## Request
$ARGUMENTS

**The prompt is the context — read the intent.** How autonomous to be, how big the scope, which world(s), whether to confirm before merging: infer it from the words. "Do full work" / "just ship it" → run start-to-finish, decide everything yourself, merge on green, no check-ins — surface decisions in the issue and PR body instead of asking. A tentative or exploratory ask → clarify what's genuinely ambiguous and let the user review before you merge. Use judgment; don't make the user configure you. The flow below is the map, not a checklist to recite — skip what doesn't apply, and always stop for a true blocker (key/token exposure across a world boundary, a CSP / remote-code violation, an auto-ship, a data-integrity risk, a policy violation from CLAUDE.md, an external dep you can't satisfy).

## The flow

1. **Understand.** Restate the goal in a line. If the ask cites URLs (article, prior art), `WebFetch` them and extract the *pattern* (the mechanism), then translate it onto our stack — MV3 three worlds (service worker = keys + network, content script = DOM, side panel = SolidJS UI), the AI SDK 7 `ToolLoopAgent` loop over OpenRouter (BYOK), Zod-validated messages across the bus, the changeset recorder, MCP handoff (`@ai-sdk/mcp`, Streamable HTTP). Everything ephemeral except the changeset → PR.

2. **Explore (parallel).** Fan out `Task` Explore agents (very thorough; `codegraph_explore` for structure) to map every affected surface and the right world(s): `src/entrypoints/{background,content}.ts` + `src/entrypoints/sidepanel/`, and the logic modules `src/agent/` (tool loop), `src/dom/` (live-edit primitives), `src/mcp/` (handoff), `src/changeset/` (recorder), `src/shared/` (Zod message contracts, the typed bus). Pull the matching skill for the surface — `live-edit`, `mv3`, `ship`, `solid-srp`, `test-extension`, `scaffold-tool`. Identify patterns to mirror (`file:line`), the tests, and the constraints from [`docs/architecture/`](../../docs/architecture) + [`docs/reference/agent-sdk.md`](../../docs/reference/agent-sdk.md). Respect the world boundaries — **never** route a key/token or `fetch` through the content script or side panel. Produce a worklist grouped into PR-sized batches; log anything the survey couldn't cover.

3. **Track in GitHub (issues).** Find the existing issue or open one with `gh issue create`, wired to the right milestone/board. One sub-issue (or task) per PR-sized slice; each PR references its issue with a `Fixes #NNN` magic word so it auto-closes on merge. Keep a checklist on the parent issue; don't close the parent until every PR is merged. A single self-contained slice can be handed straight to a dedicated `Task` agent working in this same checkout (no worktrees) that takes it branch → build → verify → PR → merge.

4. **Build — SRP, primitive first, then fan out.** One module = one responsibility; one component = one `.tsx` + co-located `.scss` (same basename); **no business logic in components** — logic lives in `src/agent|dom|mcp|changeset`, components render + dispatch only. State via signals/stores (`createStore`), never prop-drill more than one level. New agent DOM/design tool → use the `scaffold-tool` skill (schema → content-script handler → AI SDK `tool()` → recorder → test) so it's wired through all three worlds. For a multi-surface sweep, never convert N surfaces N ways: build one reusable primitive (a `src/shared` Zod message variant, a `src/dom` mutation helper, a Solid store) and land it with its first real caller — **no abstractions before consumers** — then every other surface adopts it. Fan out **parallel `Task` agents that all share this one checkout** — never `isolation: worktree`, never a per-agent worktree dir. Give each agent a disjoint set of files, coordinate so two agents never touch the same file, and land batches sequentially on one branch. Gate the `verify` skill **in the foreground**. Small feature → one branch, skip the fan-out.

5. **Verify.** Use the `verify` skill as the green gate — `bun run lint`, `bun run typecheck`, `bun run test:unit`, `bun run test:integration`, stop at first failure, fix the root cause (never silence a check or weaken a type). New module → add a unit test; new cross-world flow → add an integration test (a logic bug fixed here ships with a reproducing test). User-facing / DOM-facing → `bun run build`, load `.output/chrome-mv3` as an unpacked extension, and drive the real thing with Playwright (`mcp__playwright`) — type-check passing ≠ the side panel working, ≠ the DOM tool mutating the page. Green gate + a real loaded-extension check is the bar to merge.

6. **PR + merge sequentially via `claudetm merge-pr`.** Commit (Conventional Commit, scope = world/module e.g. `feat(content): …`, reference the issue), push, `gh pr create` (Summary + Test plan). Then merge PRs **one at a time** — for each PR run `claudetm merge-pr <PR#>`, which waits for CI, fixes failures + review comments (CodeRabbit included), resolves conflicts, and merges once green (loops until it is). **Never run them in parallel** — merging churns `main`, so start the next PR's `claudetm merge-pr` only after the previous one has actually merged, then rebase the next branch and re-run its gate. Add `-m <n>` to cap fix iterations; `--admin` only with explicit permission. Never `--force`/`--no-verify`/skip hooks without permission.

7. **Release (only when asked).** This repo ships as a packed extension, not a deploy — `bun run release` builds tree-shaken + minified + css-minified `.output` and zips Chrome + Firefox. Do **not** cut a release as part of a normal feature merge; that's an explicit, user-triggered step. A new env/permission need goes in the PR body as a callout (manifest permission, host grant), not silently added.

8. **Watch + close.** CI green, the `Fixes #NNN` magic word auto-closes each child issue when its PR merges — verify each actually flipped and close any straggler by hand with a comment linking the merged PR. Once every child is closed, close the **parent issue** yourself. Broken on `main` → forward-fix on a branch.

## Hard rules (from CLAUDE.md / principles.md — non-negotiable)

**Three worlds, load-bearing** — keys + network + MCP tokens live ONLY in the service worker; DOM access ONLY in the content script; UI ONLY in the side panel; every cross-world message is Zod-validated in `src/shared`, no `any` across the bus. **No remote code, no `eval`** — Solid is prebuilt to static JS, CSP-clean. **Thin orchestrator** — the extension designs and delegates; real coding happens in ai-dev, not here. **BYOK only** — keys live encrypted in `chrome.storage.local`, never in the repo, never resold. **Live edits are ephemeral** — never persist page mutations to any server; the only durable output is a changeset → PR. **Stable selectors** — data-attrs/roles/text, never brittle nth-child chains. **Human in the loop** — "Ship" is user-triggered, the agent never auto-merges and never auto-ships. **Privacy** — page content/screenshots go only to the user's model + their MCP; no third-party telemetry of page contents. SRP everywhere; small files; split when a file does two things. Bun + TypeScript only. Zod at every boundary. Tokens (colors/spacing/radius) from `src/styles/_tokens.scss` — never hardcode a token value.

## Output

```
Primitive:  <name> @ <path>  (PR #NNN, merged)         [sweeps only]
Surfaces:   <n> across <m> PRs → #… #…   worlds: <sw / content / sidepanel>
Verify:     lint ✓ typecheck ✓ unit ✓ integration ✓   loaded-ext: <playwright result>
Issues:     #<parent> closed (<k> sub-issues)
```
