---
description: Scaffold a new agent DOM/design tool end-to-end (schema, content-script handler, AI SDK tool, recorder, test).
---

You are running `/scaffold-tool <toolName>`. Goal: add a new live-edit tool the agent can call, wired through all three worlds. Use the `live-edit` and `mv3` skills.

Steps:
1. Add the tool's message variant to the `DomTool` Zod schema in `src/shared/messages.ts`.
2. Implement the handler in `src/entrypoints/content.ts` — reversible, emits a recorder event into the changeset.
3. Expose it as an AI SDK `tool()` with a Zod `inputSchema` in the agent layer (`src/agent/`). Pattern: `docs/reference/agent-sdk.md`.
4. If it mutates the page, ensure it produces a `Changeset` `Edit` with selector + intent + frameworkHints.
5. Add a unit test (`test/unit/`) for the pure logic and, if cross-world, an integration test (`test/integration/`).
6. Run `/verify`.

Keep each piece SRP. No keys in the content script. Report the files touched.
