---
name: ship
description: Assemble an accepted changeset and dispatch the implementation handoff over MCP to ai-dev / developerz.ai. Use when touching src/mcp, the ship flow in src/entrypoints/background.ts, or when the task mentions handoff, shipping a design, MCP task creation, or turning edits into a PR.
---

Ship turns a `Changeset` into a real code task. Runs in the **service worker** (owns keys + MCP clients). See `docs/idea/handoff.md`, `docs/idea/mcp.md`, `docs/architecture/handoff.md`.

## Rules

- **User-triggered only.** Never auto-ship. "Ship" is an explicit button → `ship` message. The agent never calls handoff on its own.
- The changeset is the spec: intent + stable selector + frameworkHints map the visual change to source.
- MCP client lives in the service worker. Connect via `@ai-sdk/mcp` `createMCPClient` over **Streamable HTTP** (not SSE). See `docs/reference/agent-sdk.md`.

## Flow

1. Assemble + validate the `Changeset` (Zod, `src/shared/changeset.ts`). Refuse empty/invalid.
2. Resolve the configured backend + auth token (ai-dev: admin/worker key or OAuth user token).
3. Open the MCP client, call `task` with `action: 'create'`, changeset as the task spec.
4. Stream status back to the panel; surface the PR link when the dev-agent opens it.
5. On failure: report the MCP error to the panel, keep the changeset (don't discard the user's work).

## Don't

- Don't persist mutations to any server — the only durable output is the changeset → PR.
- Don't embed keys/tokens in the changeset or any content-script message.
