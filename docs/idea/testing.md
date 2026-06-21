# Testing

Test pyramid: fast [Vitest](https://vitest.dev/) unit + integration run **in parallel**, then [Playwright](https://playwright.dev/) E2E on a real loaded extension. Lint/format = [Biome](https://biomejs.dev/).

## Layers

| Layer | Tool | Scope | Speed |
|-------|------|-------|-------|
| Unit | Vitest | Pure logic — selector engine, changeset recorder, message (Zod) schemas, frameworkHint extraction | ms |
| Integration | Vitest + jsdom | Agent loop end-to-end with mocked OpenRouter + mocked DOM tools; handoff assembly | sub-second |
| E2E | Playwright | Real Chromium, extension loaded unpacked, driving a fixture page | seconds |

Unit and integration are **separate Vitest projects** so CI runs them as parallel jobs (see below).

## What's mocked vs real

| Thing | Unit | Integration | E2E |
|-------|------|-------------|-----|
| OpenRouter | n/a | mocked (canned tool-call streams) | mocked or recorded |
| DOM | n/a | jsdom | real page |
| MCP backend | n/a | mock MCP server (fake `task`) | mock MCP server |
| Content ↔ SW bus | n/a | in-memory fake | real `chrome.*` |
| `chrome.*` APIs | stubbed | stubbed | real (loaded extension) |

- Never hit a live model or a real ai-dev in tests — mock both. Determinism over fidelity below E2E.
- Selector engine gets a **fixture corpus** of real-world DOM snapshots → asserts stable-selector resolution + fragility flags.
- Changeset recorder: apply mutations → assert recorded entry shape → assert undo inverts exactly.

## Integration: the agent loop

- Feed the loop a scripted OpenRouter response (tool call → result → text).
- Assert the right DOM tool fired with the right args, and the changeset entry that resulted.
- Covers the design conversation without a network or a browser.

## E2E

- `wxt build` → load unpacked in Playwright's persistent context.
- Open the side panel, type a prompt, assert the fixture page mutates and a diff entry appears.
- Ship against a mock MCP server → assert `task(action:'create')` payload.

## CI (parallel)

```
lint (biome)  ─┐
typecheck (tsc)─┤
unit (vitest)  ─┼─► all green ─► build ─► e2e (playwright)
integration    ─┘
```

- `lint`, `typecheck`, `unit`, `integration` run as independent parallel jobs on Blacksmith 2vcpu runners.
- `build` + `e2e` gate on them. See the CI workflow.

## Commands

| Command | Does |
|---------|------|
| `bun run test` | unit + integration |
| `bun run test:unit` / `test:integration` | one project |
| `bun run test:e2e` | Playwright |
| `bun run lint` / `lint:fix` | Biome check / write |
| `bun run typecheck` | `tsc --noEmit` |
