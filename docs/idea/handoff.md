# Handoff

How an accepted design session becomes a real PR. The changeset goes over [MCP](mcp.md) to a dev-agent backend ([ai-dev](https://ai-dev.miamibeachstart.com/mcp) / developerz.ai), which edits the actual source and opens a pull request. **The user clicks Ship — handoff is never automatic.**

## Input: the changeset

The ordered list of recorded edits from the design session (schema in [live-edit.md](live-edit.md)). The three fields that make source-mapping possible:

| Field | Why it matters to the dev-agent |
|-------|---------------------------------|
| `intent` | Human goal in words — maps to a meaningful commit + PR description. |
| `selector` (+ strategy, fragile) | Anchors the runtime element; resolution strategy helps find it in source. |
| `frameworkHints` | The bridge to source: Tailwind classes, CSS-module names, styled-components markers, framework markers. |

## Sequence

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

## What we never do

- Never write to the running site. The page edit was a preview; the only durable output is the PR.
- Never hold the user's publish/merge tokens. Shipping the merge is the human's call.
