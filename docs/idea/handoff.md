# Handoff

How an accepted design session becomes real code — **two output paths**, chosen automatically per session:

| Path | When | Result |
|------|------|--------|
| **Ship (MCP)** | A connected backend exposes `task` **and** the page's origin is mapped to a repo | `task(action:'create')` → dev-agent edits source → PR, streamed status |
| **Download report** | No backend connected, or no repo mapped for this origin | A pasteable Markdown brief (identity tokens, findings, before/after) — drop it into any coding agent |

Both paths consume the same recorded session (changeset and/or agent-authored `Report` for debug findings). **The user clicks Ship or Download — handoff is never automatic.** See [mcp.md](mcp.md) for the routing rule.

## Input: the changeset (+ report for debug findings)

The ordered list of recorded edits from the design session (schema in [live-edit.md](live-edit.md)); a debug-mode session also produces an agent-authored `Report` (findings, severity, root cause, screenshots) — see [../architecture/changeset.md](../architecture/changeset.md). Both render to the same Markdown brief either way (attached to every MCP task as its `brief` field, or downloaded standalone). The three changeset fields that make source-mapping possible:

| Field | Why it matters to the dev-agent |
|-------|---------------------------------|
| `intent` | Human goal in words — maps to a meaningful commit + PR description. |
| `selector` (+ strategy, fragile) | Anchors the runtime element; resolution strategy helps find it in source. |
| `frameworkHints` | The bridge to source: Tailwind classes, CSS-module names, styled-components markers, framework markers. |

## Sequence (Ship / MCP path)

```
user clicks Ship
  │
  ▼
side panel ──► service worker: assemble changeset + repo target + summary
  │
  ▼
service worker ──MCP──► ai-dev: task(action:'create', { spec: changeset, ... })
  │                          │
  │                          ├─ dev-agent pulls repo, loads CLAUDE.md context
  │                          ├─ maps frameworkHints + selector → source location
  │                          ├─ edits code, runs tests locally
  │                          └─ opens PR, polls CI
  ▼
service worker ◄──stream── task status (queued → working → pr_open → ci_green)
  │
  ▼
side panel: status timeline + PR link
```

## The task call

The changeset is the task spec. Maps to ai-dev's domain tool:

```jsonc
{
  "tool": "task",
  "arguments": {
    "action": "create",
    "template": "frontend_dev",
    "repo": "acme/storefront",
    "title": "Make primary CTA orange and larger",
    "spec": {
      "source": "developerz-designer",
      "url": "http://localhost:3000/pricing",
      "edits": [ /* changeset entries: intent, selector, changes, screenshots, frameworkHints */ ]
    }
  }
}
```

- `template` picked from the backend's agent templates (`frontend_dev` for UI work).
- `repo` chosen in the [MCP panel](mcp.md) — the user maps the page's origin to a repo once, reused after.
- Screenshots travel as attachments/URLs so the dev-agent can visually verify its result against intent.

## Status back

- Streamed over the same MCP session (ai-dev exposes `task(action:'watch')`).
- Side panel shows a timeline: `queued → working → pr_open → ci_green / ci_red`.
- On `pr_open`, surface the PR link. The user reviews and merges — **no auto-merge** (see [principles.md](principles.md)).

## Failure / mismatch

- Dev-agent can't locate the element in source → returns a question; surfaced in chat, user clarifies, re-dispatch.
- Fragile selector flagged in the changeset → dev-agent treats it as low-confidence, prefers `frameworkHints`.
- CI red → ai-dev's own loop fixes and re-pushes; the user just watches.

## Report fallback (no backend / no repo)

The same brief `task` would have received — identity tokens, per-edit intent/selector/before-after, debug findings, responsive screenshots — renders to Markdown and downloads as a file instead of dispatching. It's designed to be pasted straight into any coding agent (Claude Code, Cursor, Copilot) as a self-contained task description. Every finished session (shipped or downloaded) is retained in [history](ui.md#history) — the report is never lost even if you close the panel before pasting it.

## What we never do

- Never write to the running site. The page edit was a preview; the only durable output is a PR or a downloaded report.
- Never hold the user's publish/merge tokens. Shipping the merge is the human's call.
- Never silently pick a backend/repo — routing between MCP and report is deterministic and explained (see [mcp.md](mcp.md)).
