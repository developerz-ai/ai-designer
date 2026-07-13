---
description: Write a concise, self-contained execution plan to docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/ for another AI to implement
argument-hint: [what you want done]
allowed-tools: Write, Read, Glob, Grep, Task, Bash
---

# /planx

Produce a concise plan another AI can execute with zero extra context. Plan only — no implementation, no code execution, no edits outside the plan dir.

## Goal
$ARGUMENTS

## Steps

1. **Resolve path.** Run `date +%Y`, `date +%m`, `date +%d`. Dir = `docs/plans/<YYYY>/<MM>/<DD>/`. `Glob docs/plans/<YYYY>/<MM>/<DD>/1*` → next number = highest existing `1NN-*` + 1, else `101`. Slug = kebab-case title, max 5 words. Final plan dir: `docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/`.

2. **Explore.** `Task` (subagent_type=Explore, thoroughness="very thorough"): existing patterns + files to touch (`file:line`), the right world(s) — `src/entrypoints/{background,content}.ts`, `src/entrypoints/sidepanel/` — and logic module(s) `src/agent` (AI SDK tool loop), `src/dom` (live-edit), `src/mcp` (handoff), `src/changeset` (recorder), `src/shared` (Zod message contracts + typed bus). Tests (unit vs integration under `test/`, E2E under Playwright). Constraints in `docs/architecture/` + `docs/reference/agent-sdk.md`; skills that cover the surface (`live-edit`, `mv3`, `ship`, `solid-srp`, `test-extension`, `scaffold-tool`). Prefer `codegraph_*` for structural lookups. Skip only for trivial asks.

3. **Write the plan as multiple files** in the plan dir — never one big `plan.md`. Always produce an `overview.md` index plus one `<NN>-<aspect>.md` per separable area (e.g. `01-message-schema.md`, `02-content-handler.md`, `03-agent-tool.md`, `04-sidepanel-ui.md`, `05-changeset.md`, `06-tests.md`). Split by area of work so each file is independently executable and stays short. Match the existing house style in `docs/idea/` + `docs/architecture/` — terse fragments, `file:line` refs, tables.

   **`overview.md`** — the map. Sections:

```markdown
# <Title>

## Goal
1-2 sentences: what + why.

## Context
- Stack facts the executor needs (Bun + TS, WXT + SolidJS + SCSS, AI SDK 7 `ToolLoopAgent` over OpenRouter BYOK, `@ai-sdk/mcp` handoff, Zod at every boundary — only what's relevant).
- Which world(s) the work lives in (service worker / content script / side panel) and why the boundary matters here.
- Reference patterns: `src/<area>/<thing>.ts:12` — follow this for Z.

## Plan files (execute in order)
1. [`01-<aspect>.md`](01-<aspect>.md) — one line: what it covers.
2. [`02-<aspect>.md`](02-<aspect>.md) — ...

## Done when
- Verifiable acceptance criteria spanning the whole feature.

## Risks / open questions
- Anything the executor must decide or watch (esp. world-boundary / key-custody / CSP).
```

   **Each `<NN>-<aspect>.md`** — one slice of work. Sections:

```markdown
# <NN> — <Aspect>

> Part of [`overview.md`](overview.md). Depends on: <NN-prior or "none">.

## Files to change
- `path:line` — what changes, why. (Note which world it runs in.)

## Steps
1. Ordered, concrete actions. Reference `Class#method` / `file:line`, don't restate.

## Tests
- What to add/run. Tests written with the code. Command: `bun run test:unit`, `bun run test:integration`, `bun run typecheck`, `bun run lint`.

## Done when
- Verifiable acceptance criteria for this slice.
```

4. **Write a `status.yml`** in the plan dir (alongside `overview.md`) — the live tracker for this plan. New plans start `not_started` / `0%`. Get `created_by` + `owner` from `git config user.name` (the person running /planx). Leave `worked_by` empty — the executor sets it to their own `git config user.name` when they pick the plan up, so a plan written by one person can be worked by another. Shape:

```yaml
plan: <1NN>-<slug>
title: <human title from overview.md>
status: not_started        # not_started | in_progress | blocked | complete | superseded
created_by: <git config user.name>   # who authored the plan
worked_by: ""              # who is executing it; empty = unclaimed; executor fills with their git user.name
owner: <git config user.name>
percent: 0                 # 0–100, overall completion
current_focus: ""          # where it's at right now / next slice to pick up
slices:                    # one row per <NN>-<aspect>.md slice
  - file: 01-<aspect>.md
    status: not_started      # not_started | in_progress | complete
    percent: 0
evidence: []               # commits/PRs proving progress, e.g. ["#324", "abc1234"]
notes: ""
last_updated: <YYYY-MM-DD>
```

   Keep `status.yml` machine-readable (valid YAML, the enums above). It's the one file in the plan dir that IS a tracker — the `.md` slices stay reference maps (no checkboxes there).

## Rules
- Compact English. Fragments over sentences. `file:line` and `Class#method` symbol refs over prose. Tables for structured data.
- Reference-only: point at code, don't paste it or re-explain it ("follow `x.ts` but ...").
- No checkboxes (`[ ]`). Plain bullets. The plan is a reference map, not a tracker.
- Multiple files always: `overview.md` + `<NN>-<aspect>.md` slices. Never a single `plan.md`.
- Self-contained: executor reads only `overview.md`, the slice it's on, and the files those cite.
- Respect `CLAUDE.md` + `docs/idea/principles.md`: **three worlds** (keys + network + MCP tokens only in the service worker, DOM only in the content script, UI only in the side panel; every cross-world message Zod-validated in `src/shared`, no `any` across the bus). **No remote code / `eval`** — Solid prebuilt, CSP-clean. **Thin orchestrator** — the extension designs and delegates; real coding happens in ai-dev, not here. **BYOK only** — keys encrypted in `chrome.storage.local`, never in the repo. **Live edits ephemeral** — only durable output is a changeset → PR. **Stable selectors** (data-attrs/roles/text). **Human in the loop** — Ship is user-triggered; never auto-ship, never auto-merge.
- Stack rules: TS strict, no `any`, no `as` without a why-comment. Biome (no ESLint/Prettier). Zod at every boundary (message bus, `chrome.storage`, MCP, model I/O). SolidJS SRP — one component per `.tsx` + co-located `.scss`, no business logic in components, state in signals/stores. SCSS scoped to a root class, tokens from `src/styles/_tokens.scss` (never hardcode a token value).
- Cross-repo work (the ai-dev / developerz.ai MCP backend that receives the handoff) → one `<NN>-<aspect>.md` per repo; note that repo is edited from its own checkout, not here.

## Output
```
✓ docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/overview.md
  + 01-<aspect>.md, 02-<aspect>.md, … (one per area)
  + status.yml (tracker — status/owner/percent/current_focus)
Next: run an executor on overview.md.
```
