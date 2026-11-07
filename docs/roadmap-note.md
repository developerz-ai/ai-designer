# Shipped — the v0 record

Design in the live page, ship the real code. The full v0 design loop is shipped and running: chat → live edits → changeset → ship-or-report. This page is the authoritative shipped-state record; reader-facing docs point here instead of asserting their own status.

## What shipped

The [agentic designer vision plan](plans/2026/07/13/101-agentic-designer-vision/) — the anthology of stacked slices **S1–S021-H01** — shipped in full via **PRs #71–#105**:

| Delivered | What it is |
|-----------|------------|
| Side-panel chat | Solid SPA, agent loop via AI SDK 7 `ToolLoopAgent`, BYOK provider config, readiness gate |
| Live edit | DOM/CSS mutation in the content script, picker + overlay, ephemeral browser-only preview |
| Changeset | Structured record with stable selectors, before/after, screenshots, per-entry undo/redo |
| Ship-or-report | Changeset → MCP `task(action:'create')` → real PR when a backend + repo target is mapped; else a downloadable `.md` brief for any coding agent |

Plan history stays in `docs/plans/…/101-agentic-designer-vision/` for rationale; the delivered surface is described in `docs/idea/roadmap.md`.

## What is next

- **v1** — next up: design-token awareness, team sharing, push status updates, server-side memory, and the origin→repo mapping writer (#20).
- **v2** — later: deeper framework integration and the release/patch backlog items, deliberately deferred to a later cycle.
