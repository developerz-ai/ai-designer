# Roadmap

## v0 — Design loop

Prove the conversation + live edit. No handoff.

| Ships | Notes |
|-------|-------|
| Side-panel chat (SolidJS) | [Vercel AI SDK](agent.md) + OpenRouter, BYOK |
| Element picker + DOM tools | Ephemeral mutations, [live-edit](live-edit.md) |
| Changeset recorder + diff review | Stable selectors, before/after screenshots |
| Settings | OpenRouter key, model picker |

Success: redesign a real page by talking, see it instantly, review the diff.

## v1 — Ship it

The full loop: design → real PR.

| Ships | Notes |
|-------|-------|
| MCP management UI | Connect [ai-dev](mcp.md), auth (OAuth/PKCE + API key) |
| Handoff | Changeset → `task(action:'create')` → PR, status stream |
| Origin→repo mapping | One-click Ship per site |
| Design-time read tools | Consult repo `kb` so edits match codebase tokens |

Success: "Ship it" produces a reviewable PR that matches the preview.

## v2 — Scale

| Ships | Notes |
|-------|-------|
| Multi-backend | ai-dev + developerz.ai + GitHub MCP + custom |
| Design-token awareness | Edits emit token changes, not raw values |
| Team sharing | Shareable changesets / sessions |
| Responsive capture | Multi-breakpoint edits in one changeset |

## Anti-roadmap

Won't build:

- **Page builder / no-code host** — we edit *your* codebase, not a proprietary format.
- **Our own coding agent** — coding stays in [ai-dev](mcp.md) / developerz.ai. Thin orchestrator (see [principles.md](principles.md)).
- **Prod auto-writes** — the page edit is a preview; the only durable output is a PR.
- **Token reselling** — BYOK always.
- **Figma-style greenfield design** — we shine on existing rendered UIs.
