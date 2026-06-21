# `.claude/` — AI-first config

Shared context for Claude Code (human devs) **and** the ai-dev worker agent that receives handoffs. One source of truth — update once, both get it on next pull. See `docs/idea/ai-first.md`.

## Layout

| Path | What |
|------|------|
| `settings.json` | Permissions allowlist + PostToolUse hooks (lint:fix + typecheck on edit) |
| `skills/` | Expert hats, auto-activated by keyword |
| `agents/` | Spawnable subagents |
| `commands/` | Slash commands for repeated flows |

## Skills

| Skill | When |
|-------|------|
| `live-edit` | DOM primitives, picker, stable selectors, recorder (`src/dom`, `content.ts`) |
| `ship` | Assemble changeset → MCP handoff to ai-dev (`src/mcp`, ship flow) |
| `mv3` | Three-world separation, key custody, CSP, ephemeral SW |
| `solid-srp` | One component = `.tsx` + co-located `.scss`; thin stores |
| `test-extension` | Vitest unit/integration + Playwright E2E |

## Agents

- `extension-reviewer` — blocks on world-boundary / key-custody / SRP violations.

## Commands

- `/verify` — lint + typecheck + unit + integration gate.
- `/scaffold-tool <name>` — new agent DOM tool, wired through all three worlds + tests.

## Hooks

`PostToolUse` on `Edit|Write|MultiEdit` runs `bun run lint:fix` then a non-blocking `typecheck` warn. Hooks run in the harness, not the model — that's why automation lives here.
