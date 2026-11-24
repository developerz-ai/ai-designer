# Testing

Test pyramid: fast [Vitest](https://vitest.dev/) unit + integration run **in parallel**, then [Playwright](https://playwright.dev/) E2E on a real loaded extension. Lint/format = [Biome](https://biomejs.dev/).

## Layers

| Layer | Tool | Scope | Speed |
|-------|------|-------|-------|
| Unit | Vitest | Pure logic — selector engine, changeset recorder, message (Zod) schemas, frameworkHint extraction | ms |
| Integration | Vitest + jsdom | Agent loop end-to-end with mocked OpenRouter + mocked DOM tools; handoff assembly | sub-second |
| E2E | Playwright | Real Chromium, extension loaded unpacked, driving a fixture page | seconds |

One Vitest project (`vitest.config.ts`), two directories: `test/unit/` and `test/integration/`, selectable per directory with `bun run test:unit` / `test:integration`. CI runs both in ONE `bun run test` job, one worker pool — not as separate jobs (see below).

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
- Open the side panel, type a prompt → recorded-edit chip + Ship bar appear (chat-streaming spec, stubbed model); DOM tools mutate/undo the fixture page over the real content-script bus (dom-tools spec).
- Ship against a mock MCP server → assert `task(action:'create')` payload.

## CI

Six jobs in `.github/workflows/ci.yml` — the workflow is the source of truth:

```
Lint (biome)     ─┐                         ┌─► Build extension (needs both)
                 ├─ (starts in parallel) ──┤
Typecheck (tsgo) ─┘                         └─► Test (e2e)      (needs both)

Test (unit + integration)   no needs — ONE `bun run test`
actionlint                  no needs — downloads its own binary
```

- `Lint` (`bun run lint`), `Typecheck` (`bun run postinstall` → `bun run typecheck`) and `Test (unit + integration)` are independent jobs with no `needs:` — all three start at once on `ubuntu-latest`. Unit and integration share ONE job and one vitest worker pool (`ci.yml:60-75`); they are not split.
- `Build extension` and `Test (e2e)` are siblings, each gated on `Lint` + `Typecheck` only — never on the test job, which keeps the suite off the build's critical path (`ci.yml:81`, `ci.yml:115`). `Test (e2e)` runs its own `bun run build` rather than consuming `build`'s artifact.
- `actionlint` is CI-only: it downloads the 1.7.12 binary at job time, so it is not a dependency of this repo (`ci.yml:149-160`).
- Locally `./bin/check` mirrors the three validation jobs via `bun run verify`; `Build extension`, `Test (e2e)` and `actionlint` are CI-only — the gate reports them rather than skipping them silently, and `bun run gate` adds the first two. See [RELEASING.md](../RELEASING.md#ci-gate).

## Commands

| Command | Does |
|---------|------|
| `bun run test` | unit + integration |
| `bun run test:unit` / `test:integration` | one directory (`vitest run unit` / `integration`) |
| `bun run test:e2e` | Playwright |
| `bun run lint` / `lint:fix` | Biome check / write |
| `bun run typecheck` | `tsgo --noEmit` (`typecheck:tsc` for the stock-tsc bisect) |
