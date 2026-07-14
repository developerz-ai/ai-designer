# Roadmap

## Shipped — design loop + ship-or-report

The full loop, plus the polish that makes it usable day to day. See `docs/plans/2026/07/13/101-agentic-designer-vision/` for the slice-by-slice build plan; this is the delivered surface.

| Ships | Notes |
|-------|-------|
| Side-panel chat (SolidJS) | [Vercel AI SDK](agent.md) `ToolLoopAgent`, any OpenAI-compatible provider (BYOK), model picker |
| Readiness / Start gate | Provider + model + host-permission checklist; MCP optional, never blocks Start |
| Element picker + agent-decision overlay | Ephemeral mutations, Cursor-style hover/highlight, opt-in live step mirror — [live-edit](live-edit.md), [ui.md](ui.md#overlay) |
| Changeset recorder + Ship bar | Stable selectors (incl. shadow-DOM), before/after, per-entry undo/redo |
| Copy mode | `browse` a reference site, `extractIdentity`, apply palette/type/spacing to the current page |
| Debug mode | `diagnostics` collector + observe→hypothesize→reproduce→confirm→root-cause→fix loop, agent-authored report |
| MCP management | Connect ai-dev / developerz.ai / GitHub / custom servers, three-tier auth (admin key, worker key, OAuth+PKCE), origin→repo mapping |
| Handoff — ship or report | Changeset/report → `task(action:'create')` when backend+repo mapped, else downloadable Markdown brief — [handoff.md](handoff.md) |
| History | Last 10 conversations + reports/PR links, read-only replay |
| FontAwesome icon system | Self-hosted SVG, no runtime fetch, no `eval` |
| Complex sites | SPA/shadow-DOM/canvas-chart reads (Chart.js/ECharts/Highcharts/D3/Recharts), ARIA-widget interaction recipes |
| Responsive / mobile | Device emulation, multi-breakpoint capture, mobile problem scan |

Success (met): talk → agent redesigns or debugs the real page, self-corrects visually, and either ships a PR or hands you a report — with zero required setup beyond a provider key.

## Next

| Candidate | Notes |
|-----------|-------|
| Design-token awareness | Edits emit token changes, not raw values, when a token system is detected |
| Team sharing | Shareable changesets / sessions |
| Push status updates | Subscribe to backend task `watch` events instead of polling |
| Server-memory | Cross-session project memory beyond the local last-10 history |

## Anti-roadmap

Won't build:

- **Page builder / no-code host** — we edit *your* codebase, not a proprietary format.
- **Our own coding agent** — coding stays in [ai-dev](mcp.md) / developerz.ai, or in whatever agent the user pastes the report into. Thin orchestrator (see [principles.md](principles.md)).
- **Prod auto-writes** — the page edit is a preview; the only durable output is a PR or a downloaded report.
- **Token reselling** — BYOK always, any OpenAI-compatible provider.
- **Figma-style greenfield design** — we shine on existing rendered UIs.
