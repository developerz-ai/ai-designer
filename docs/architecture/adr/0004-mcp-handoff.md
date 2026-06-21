# ADR 0004 — Implementation via MCP handoff

**Status:** accepted

## Context

The extension can change a live page, but live edits are ephemeral. Turning them into real code is a different, heavyweight job: locate source, edit idiomatically, run tests, open a PR, fix CI. Building that into the extension would duplicate existing dev-agent platforms (ai-dev, developerz.ai).

## Decision

Keep the extension a **thin designer**. Hand the changeset off over **MCP** to an external dev-agent backend that owns implementation. Reference backend: ai-dev (`task` domain tool); developerz.ai as the other first-class target. The extension requires only a task-create + status-get capability.

## Consequences

- ✅ Clear separation: design here, implementation there. No reinventing a coding agent.
- ✅ Backend-agnostic — any MCP server with task-create works.
- ✅ Real output is a reviewable PR with CI, not a silent prod write.
- ✅ `frameworkHints` in the changeset let the dev-agent produce idiomatic diffs (see [../changeset.md](../changeset.md)).
- ➖ Requires a connected, authenticated MCP backend to ship (design works standalone).
- ➖ Status is poll-based in v1 until backend push/`watch` is wired (v2).
