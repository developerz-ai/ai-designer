# 12 — Docs, wiki guide, CLAUDE.md refresh

> Part of [`overview.md`](overview.md). Depends on: all prior slices (document shipped behavior). World: **docs only**. User: "we also need updated docs … wiki guide, update claude.md etc". House style: lead with the rule, fragments, tables, `file:line` (`docs/idea/principles.md`, CLAUDE.md).

## Why
The idea/architecture docs describe the v0/v1 design loop; the shipped vision adds openai-compatible providers, custom MCP + auth, readiness/Start, copy/debug modes + browse, MD-report fallback, history, overlay, FontAwesome. Docs + CLAUDE.md must match reality; add a user-facing wiki guide.

## Files to change
- `docs/idea/overview.md`, `docs/idea/agent.md`, `docs/idea/mcp.md`, `docs/idea/handoff.md`, `docs/idea/ui.md`, `docs/idea/roadmap.md` — update to reflect: multi-provider (not OpenRouter-only), readiness/Start, copy/debug modes + `browse`, **MD-report OR MCP** dual output, history, overlay. Correct the OpenRouter-only framing in `agent.md:38-41` / `roadmap.md`.
- `docs/architecture/agent-loop.md`, `docs/architecture/mv3-worlds.md`, `docs/architecture/components.md`, `docs/architecture/changeset.md`, `docs/architecture/handoff.md` — reflect the new modules: `src/agent/{loop,provider,modes,browse,history-store}`, `src/mcp/*`, `src/dom/{mutate,read,picker,recorder,overlay,diagnostics-collector}`, `src/changeset/{store,report}`. Note browse-tab + report paths + overlay forwarding.
- `docs/reference/agent-sdk.md` — add the `createOpenAICompatible` provider path alongside OpenRouter; note it's the generalized default.
- `docs/wiki/` — **new dir**. User-facing guide:
  - `docs/wiki/README.md` — index.
  - `docs/wiki/getting-started.md` — install → Settings (provider + model) → add MCP server (OAuth/API key) → readiness → Start.
  - `docs/wiki/using-copy.md` — copy a site (with/without your own).
  - `docs/wiki/using-debug.md` — debug a feature; diagnostics.
  - `docs/wiki/ship-or-report.md` — MCP handoff vs downloadable MD report; when each.
  - `docs/wiki/history.md` — last-10 conversations + reports.
  - `docs/wiki/privacy-keys.md` — BYOK, key custody, three-worlds, what leaves the browser (nothing but the PR/report you trigger).
- `CLAUDE.md` — update Stack (openai-compatible provider, not OpenRouter-hardcoded), add the new module map (`src/mcp`, `src/changeset`, agent submodules, `Icon`/FontAwesome, history, overlay), note the MD-report output path + readiness/Start. Keep it terse, table-driven.
- `docs/idea/roadmap.md` — mark v0/v1 items done as they land; add the vision items (copy/debug modes, report fallback, history, overlay, multi-provider) to the roadmap tiers.
- ADR (optional): `docs/architecture/adr/` — one ADR for "openai-compatible provider (generalize from OpenRouter)" and one for "MD-report fallback when no coding MCP".

## Steps
1. Update `docs/idea/*` + `docs/architecture/*` to match shipped modules — reference `file:line`, don't paste code.
2. Add the `createOpenAICompatible` path to `docs/reference/agent-sdk.md`.
3. Write `docs/wiki/*` (user-facing, screenshot slots from `.codegraph/*.png` optional).
4. Refresh `CLAUDE.md` Stack + module map + output paths.
5. Add ADRs if the executor changed a documented decision.

## Tests
- No code tests. Verify: internal doc links resolve; `file:line` refs point at real symbols post-implementation; `bun run lint` (if it lints md) clean.
- Sanity: a new contributor can follow `docs/wiki/getting-started.md` end-to-end.

## Done when
- `docs/idea`, `docs/architecture`, `docs/reference/agent-sdk.md` describe the shipped behavior (no OpenRouter-only claims).
- `docs/wiki/` guide covers install → configure → copy/debug → ship-or-report → history → privacy.
- `CLAUDE.md` reflects the new modules + output paths. Links resolve.
