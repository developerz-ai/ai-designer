# developerz.ai Designer — Idea Docs

Chrome extension. **Talk to an agent, redesign the live page in real time, then ship the real code.**

Pitch: **Design in the page. Ship the real code.**

You open any site — your prod app or `localhost` — open a side-panel chat, and tell an agent what to change. It mutates the live DOM/CSS instantly so you *see* it. When you like it, the agent distills the visual changes into a structured spec and hands it off over **MCP** to a dev-agent backend ([developerz.ai](https://developerz.ai/mcp)) that makes the real code change and opens a PR — or, with no backend/repo mapped, hands you a downloadable Markdown brief instead.

Two surfaces, one extension: a **chat** (design conversation) and **MCP management** (where the work actually lands).

## Read in this order

| File | Scope |
|------|-------|
| [overview.md](overview.md) | Vision, audience, the design→ship loop |
| [principles.md](principles.md) | Non-negotiables. Read before designing anything |
| [architecture.md](architecture.md) | Components, data flow, MV3 boundaries |
| [extension.md](extension.md) | Manifest V3 layout — side panel, content script, isolated worlds |
| [live-edit.md](live-edit.md) | Ephemeral DOM/CSS edits, overlay, the changeset recorder |
| [agent.md](agent.md) | Vercel AI SDK loop, OpenRouter + BYOK, design tools |
| [../reference/agent-sdk.md](../reference/agent-sdk.md) | AI SDK 7 API reference — `ToolLoopAgent`, OpenRouter, MCP, version gotchas |
| [handoff.md](handoff.md) | Changeset → implementation task → PR |
| [mcp.md](mcp.md) | MCP management UI, connecting ai-dev / GitHub, auth |
| [ui.md](ui.md) | SolidJS side panel — chat + MCP + history + settings tabs |
| [testing.md](testing.md) | Unit + integration + E2E pyramid, what gets mocked |
| [ai-first.md](ai-first.md) | How we build it with Claude Code — `.claude/`, skills, compressed config |
| [roadmap.md](roadmap.md) | Shipped / Next / Anti-roadmap |

## How it works

```
You ─chat─► Agent ─DOM tools─► live page (ephemeral)
              │                    │ you iterate, see it instantly
              │ "ship it"          ▼
              └─► changeset (selectors, styles, screenshots, intent)
                     │ MCP                                │ Download report
                     ▼                                    ▼
              developerz.ai ─► real code edit ─► PR ─► CI
                                                      Markdown brief
```

- **Design loop.** In-browser agent edits the real DOM/CSS. Nothing persists — it's a sandbox over the page you're looking at.
- **Capture.** Every accepted edit is recorded as a structured changeset: stable selector, before/after, computed styles, before/after screenshots, your intent in words.
- **Handoff.** Changeset goes over MCP to a dev-agent that finds the source, makes the equivalent change in the codebase, runs tests, opens a PR. No backend/repo mapped → **Download report**, a Markdown brief you paste into any coding agent.
- **BYOK.** OpenRouter key for the design agent. MCP token for the dev backend. We never resell tokens.

## Stack

| Component | Technology |
|-----------|-----------|
| Extension | Chrome MV3 — side panel, content scripts, service worker |
| UI | [SolidJS](https://www.solidjs.com/) — chat + MCP panel, prebuilt static bundle |
| Agent | [Vercel AI SDK](https://github.com/vercel/ai) loop in the extension, BYOK |
| Inference | [OpenRouter](https://openrouter.ai/docs) — model-agnostic |
| Handoff | [MCP](https://modelcontextprotocol.io/) → [developerz.ai](https://developerz.ai) |
| Build | [Bun](https://bun.sh/) + TypeScript + [WXT](https://wxt.dev/) (or CRXJS) |
| Tests | [Vitest](https://vitest.dev/) unit + integration, Playwright E2E on a loaded extension |

See [testing.md](testing.md) for the test pyramid and [ui.md](ui.md) for the Solid surfaces.

## Status

v0 shipped: the full design loop — chat → live DOM/CSS edits → changeset → **Ship** hands it to a backend that opens a PR, or downloads a Markdown report when no backend/repo is mapped. Readiness/Start gate, copy + debug modes, history and the on-page overlay are in. See [roadmap.md](roadmap.md).
