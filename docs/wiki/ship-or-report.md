# Ship or report

Every session ends the same way: you click a button. The extension never sends your changes anywhere on its own.

## Two outcomes, chosen automatically

| Outcome | When | What you get |
|---------|------|---------------|
| **Ship** | An MCP backend is connected *and* this page's origin is mapped to a repo | A real PR — the dev-agent maps your edits to source, writes code, opens a PR |
| **Download report** | No backend connected, or no repo mapped for this origin | A Markdown file — paste it into any coding agent (Claude Code, Cursor, Copilot, whatever you use) |

You don't choose the path — the Ship bar shows whichever is actually available. Connecting a backend is step one; the origin→repo mapping that completes **Ship** is storage-only today (no UI yet — #20).

## What's in the brief either way

- **Identity tokens** — palette/type/spacing extracted during the session (copy mode).
- **Per-edit record** — intent in plain words, the resolved selector, before/after values, screenshots.
- **Debug findings** — if you ran debug mode: severity, root cause, repro screenshots.
- **Framework hints** — Tailwind classes, CSS-module names, styled-components markers — the dev-agent's bridge from "this DOM element" to "this line of source".

## Ship (MCP) path

1. Click **Ship**.
2. Side panel sends the changeset + repo target to your connected backend.
3. A timeline appears: `queued → working → pr_open → ci_green` (or `ci_red`, which the backend's own loop usually fixes and re-pushes).
4. On `pr_open`, the PR link shows up in the timeline. **You review and merge it** — nothing auto-merges.

If the dev-agent can't find the element in source, it comes back with a question in chat instead of guessing — answer it and it re-dispatches.

## Download report path

1. Click **Download**.
2. A `.md` file lands in your downloads folder — same brief a Ship task would have received.
3. Paste it into any coding agent as a self-contained task description.

Nothing is uploaded anywhere in this path — the file is generated and saved locally.

## What never happens

- No auto-ship. The agent finishes editing and stops — it never calls Ship/Download itself.
- No auto-merge. A PR is opened; a human merges it.
- No silent backend/repo pick — the extension is deterministic about which path you get, and why (see the Ship bar's status text).

## After you ship or download

Every finished session — shipped or downloaded — is kept in [History](history.md), so the report/PR link isn't lost if you close the panel before acting on it.
