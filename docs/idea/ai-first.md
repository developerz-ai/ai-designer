# AI-first

How we build this with Claude Code. Convention from [github.com/sebyx07/claude-code-bible](https://github.com/sebyx07/claude-code-bible) — ch. 2 (skills/agents/commands), ch. 11 (compressed config).

## Layers

| Layer | Path | Purpose |
|-------|------|---------|
| Project memory | `CLAUDE.md` | Stack, SRP rules, commands, MV3 boundaries — read every session |
| Area memory | `src/*/CLAUDE.md` | Per-area rules — none yet; add as an area earns rules (e.g. `src/dom/CLAUDE.md`: selector heuristics) |
| Skills | `.claude/skills/*/SKILL.md` | Expert hats, auto-activated by keyword |
| Agents | `.claude/agents/*.md` | Spawned subagents for fan-out work |
| Commands | `.claude/commands/*.md` | Slash commands for repeated flows |

## Skills

| Skill | Does |
|-------|------|
| `live-edit` | DOM mutation primitives + stable-selector heuristics — the [live-edit](live-edit.md) rules |
| `ship` | Assemble a changeset → dispatch the [handoff](handoff.md) MCP task; validate spec shape |
| `mv3` | Manifest V3 gotchas — world separation, CSP, ephemeral service worker |
| `solid-srp` | One component = one `.tsx` + co-located `.scss`; thin stores |
| `test-extension` | Vitest projects + Playwright-on-loaded-extension patterns ([testing.md](testing.md)) |

SKILL.md anatomy: `name`, keyword-rich `description` (drives auto-activation), `allowed-tools` (least privilege — a debug skill gets `Read`+`Bash` only).

## Compressed config

Config is read every session — write it terse (ch. 11):

- Lead with the rule, not the reason.
- Fragments over sentences. Tables over paragraphs. File paths over descriptions.
- Drop filler/hedges/meta-framing. `MUST`/`NEVER` for hard rules.
- Exact commands/paths stay exact; compress prose only.

## Hooks

`.claude/settings.json` — automate on file events:

| Hook | Trigger | Action |
|------|---------|--------|
| Format + typecheck | `PostToolUse` on `Edit`/`Write`/`MultiEdit` | `bun run lint:fix` (silent), then `bun run typecheck` (repo-wide, non-blocking — typecheck failure prints a warning) |

Hooks are executed by the harness, not the model — that's why automation lives here, not in prose.

## Shared context with the dev-agent

The [handoff](handoff.md) target (ai-dev) reads the same `CLAUDE.md` / `.claude/` files as context. Human devs and worker agents share one source of truth — update once, both get it on next pull.
