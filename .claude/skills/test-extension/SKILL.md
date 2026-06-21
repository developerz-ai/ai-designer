---
name: test-extension
description: Testing patterns for the extension — Vitest unit + integration projects and Playwright E2E on a loaded extension. Use when writing or fixing tests, setting up mocks for the agent loop / DOM tools / MCP, or when CI test jobs fail.
---

Test pyramid. See `docs/idea/testing.md`. CI runs unit + integration as **parallel** jobs.

## Layers

| Layer | Dir | Env | What |
|-------|-----|-----|------|
| Unit | `test/unit/` | jsdom | pure logic — selector engine, changeset recorder, Zod message schemas |
| Integration | `test/integration/` | jsdom | agent loop with **mocked OpenRouter** + **mocked DOM tools**; changeset assembly |
| E2E | `test/e2e/` | real Chromium | Playwright loads the unpacked extension, drives a fixture page, asserts the panel mounts + a real edit applies |

## Commands

`bun run test` (all) · `bun run test:unit` · `bun run test:integration` · `bun run test:e2e` (needs a browser) · `bun run test:coverage`.

## What to mock vs run real

- **Mock**: the model (OpenRouter responses), network, `chrome.*` APIs in jsdom.
- **Real**: selector resolution, changeset shape, Zod schemas, the tool-call plumbing.
- Keep the model mock deterministic — assert the agent's tool calls, not prose.

## Adding tests

- New module → unit test under `test/unit/`.
- New cross-world flow → integration test under `test/integration/`.
- Match the Vitest project by directory (`test:unit` filters `unit`, `test:integration` filters `integration`).
