# ADR 0006 — Markdown report fallback when no MCP backend

**Status:** accepted

## Context

The primary handoff path is MCP: Ship sends a changeset + report as an MCP `task` to ai-dev or another backend, which implements the real code change and opens a PR. However, MCP requires configuration (server URL, OAuth token, or API key). Users may not want to set up a backend, or may want to design without MCP and reuse the report later (e.g., paste it into GitHub Copilot, Claude, or a local coding agent).

## Decision

**Ship offers two routes:**
1. **MCP task (primary)**: if a backend is configured + authenticated → `handoff.ts` sends `task(action:'create', spec)`.
2. **Markdown report (fallback)**: if no backend or user clicks Download → render changeset to a portable `.md` (identity tokens, per-breakpoint findings + screenshots) → browser download folder. The report is self-contained and can be pasted into any coding agent.

Both are generated from the same `Report` schema; the `.md` is also attached as the `brief` field in every MCP task spec.

## Consequences

- ✅ MCP optional — design works standalone. Reduces onboarding friction for solo design use.
- ✅ Report portable — users can paste into any LLM or share with a team.
- ✅ Same report rendering (identity + findings) reaches both MCP backends (as `brief`) and users (as `.md` download).
- ✅ Mirrors ai-dev's fallback strategy: design here, implementation anywhere (open ecosystem).
- ➖ No automatic PR when MCP is absent (vs. "Ship now"). Mitigated by clear UI messaging (Download vs. Ship buttons).
- ➖ `.md` alone does not track the code change back (no PR URL in the history). Tracked as a Design issue (v2: re-upload `.md` → link to PR).

## Related

- [ADR 0004](0004-mcp-handoff.md) — MCP primary, this adds the fallback.
- [`src/changeset/report-md.ts`](../../../src/changeset/report-md.ts) — Markdown renderer.
- [`src/mcp/handoff.ts`](../../../src/mcp/handoff.ts) — routing logic (MCP or fallback).
- [`docs/architecture/handoff.md`](../handoff.md) — full routing flowchart.
