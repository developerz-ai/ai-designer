# Overview

**Design in the live page, then ship the real code.** A Chrome extension where you talk to an agent, it redesigns the page you're looking at in real time, and — when you're happy — hands the change off to a dev-agent backend that writes the actual code and opens a PR.

It's a **visual planning tool for changes to existing apps/sites**. You explore the change on the real rendered page — *even on production* — get it exactly right by eye, and only then turn it into a concrete implementation task. The live edit is the spec. Production is safe: edits are ephemeral and browser-only; nothing ships except as a reviewable PR against the repo.

## The problem

- Design tools (Figma) produce mockups, not code. Someone re-implements them by hand.
- "Make the button bigger" is a 30-second change that becomes a ticket, a handoff, a sprint.
- DevTools lets you edit the live page — but the edits vanish on reload and never reach the repo.
- Coding agents write code from text prompts, blind to what the page actually looks like.

The gap: **the thing you see** (the rendered page) and **the thing you change** (the source) are disconnected.

## The loop

| Step | Where | What happens |
|------|-------|--------------|
| 1. Talk | Side-panel chat | "Make the hero full-bleed, CTA orange, tighten the nav." |
| 2. See | Live page | Agent mutates real DOM/CSS. Instant. You react, refine. |
| 3. Accept | Diff review | Each change recorded as a structured changeset entry. |
| 4. Ship | MCP handoff | Changeset → dev-agent → finds source → edits code → PR. |
| 5. Verify | PR / CI | Real change, tested, reviewable. You merge. |

Design and implementation become one conversation. You never leave the page.

## Audience

| Who | Why they care |
|-----|---------------|
| Solo devs / indie hackers | Skip the design→code round-trip on their own product |
| Designers who don't code | Express intent on the real page; code lands as a PR |
| PMs / founders | "Try" a UI change on prod-like staging, ship it without a dev |
| Agencies | Iterate on a client's live site, deliver PRs not mockups |

## Two halves of the extension

- **Chat** — the design conversation. Vercel AI SDK loop, OpenRouter, BYOK. Has tools to read and mutate the live page.
- **MCP management** — where work lands. Connect [ai-dev](mcp.md), GitHub, or developerz.ai; the agent dispatches the real implementation task there.

## Works on

- **Localhost** — your dev server. Tightest loop; the dev-agent edits the same repo you're running.
- **Staging / prod** — any site you can load. The dev-agent needs repo access to ship, but you can design anywhere.

## What it is not

- Not a page builder or no-code site host. It edits *your* codebase, not a proprietary format.
- Not a Figma replacement for greenfield design — it shines on **existing** rendered UIs.
- Not a coding agent itself. It *designs* and *delegates*; coding stays in [ai-dev](mcp.md) / developerz.ai. See [principles.md](principles.md).
