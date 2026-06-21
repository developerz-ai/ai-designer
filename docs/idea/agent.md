# Agent

The design agent. A [Vercel AI SDK](https://github.com/vercel/ai) loop running in the extension's service worker, talking to [OpenRouter](https://openrouter.ai/docs) (BYOK), driving DOM tools to edit the live page.

## Loop

```
user msg ─► agent (generateText / streamText, tools, maxSteps)
              │
              ├─ reads page (query, getComputedStyle, screenshot)
              ├─ mutates page (setStyle, setText, insertNode, ...)
              ├─ asks clarifying questions in chat
              └─ records accepted edits to the changeset
```

- `streamText` with `stopWhen: stepCountIs(N)` for multi-step turns; tokens stream to the side panel.
- Tools are the only way the agent touches the page — it has no direct DOM handle (it's in the service worker).
- Vision-capable models receive screenshots so the agent *sees* its own result and self-corrects.

## Inference — OpenRouter, BYOK

- One key, every model. User picks per session; sensible default (a strong vision model) out of the box.
- Cost-aware: cheap model for chat/planning, vision model only when a screenshot is needed.
- Key stored encrypted in `chrome.storage.local`, used **only** from the service worker.

## Tool catalog

Page-read:

| Tool | Args | Returns |
|------|------|---------|
| `query` | selector \| picker-focus | matched elements + stable selectors |
| `getStyles` | selector | computed styles (relevant subset) |
| `screenshot` | selector? | element crop or viewport PNG |
| `a11ySnapshot` | selector | role/name tree (cheaper than a screenshot) |

Page-mutate (each reversible, each records to changeset — see [live-edit.md](live-edit.md)):

| Tool | Args |
|------|------|
| `setStyle` | selector, props |
| `setText` / `setAttr` | selector, value |
| `addClass` / `removeClass` | selector, class |
| `insertNode` / `moveNode` / `removeNode` | selector, html?, target? |
| `injectCss` | css |
| `setViewport` | width, height |

Session:

| Tool | Args |
|------|------|
| `recordEdit` | intent — finalize the last mutations as a changeset entry |
| `undo` / `redo` | — |
| `handoff` | backend, summary — dispatch the changeset over MCP (see [handoff.md](handoff.md)) |

## Memory

- **Turn context** — chat history + current changeset summary.
- **Page facts** — framework hints, design-token guesses, recurring class patterns, cached per URL for the session.
- **No long-term server memory** in v1; settings only.

## Guardrails

- Mutations are reversible and previewed — no destructive surprise.
- Agent never calls `handoff` on its own; the user clicks Ship.
- Token/step budget per turn; stop and ask rather than loop.
- Selector fragility surfaced to the user before recording.

## MCP tools at design time (optional)

If an MCP backend exposes read tools (e.g. ai-dev's `kb` / repo search), the agent can *consult* them while designing — "what design tokens does this repo define?" — so its edits already speak the codebase's language. Handoff then carries less guesswork. See [mcp.md](mcp.md).

## Reference

Current SDK API (AI SDK 6 `ToolLoopAgent`, OpenRouter provider, `@ai-sdk/mcp`), code sketches, and version gotchas: [../reference/agent-sdk.md](../reference/agent-sdk.md).
