# AI-first scorecard

> Written by the developerz.ai maintainer agent — established by dz-runner setup mode. Each onboarding run rewrites this file whole; the latest run wins, and the same card is stored on the platform.

- Run: `run_b4db95ae46df42cc80b19b3c80514209`
- Computed: 2026-11-02T04:24:13.803Z
- Proof: **proved** — every command ran green at head.
- Score: 13 of 15 items ok

## `policy` — ok

- .dz/maintainer/maintainer.yml already present, left alone
- .dz/maintainer/reviewer.md established

## `brain` — ok

- CLAUDE.md already present, left alone

## `roster` — ok

- .claude/agents already present, left alone

## `skills` — ok

- .claude/skills already present, left alone

## `scripts` — ok

- bin/setup established
- bin/dev established
- bin/check established
- bin/stop established
- down: ./bin/stop (bin)
- ./bin/setup exited 0 at head (28.8s)

## `wiring` — ok

- .mcp.json established

## `commands` — ok

- .claude/commands already present, left alone

## `access` — gap

- landed 0 of 9 asked
- still missing: CRX_PRIVATE_KEY, CRX_PUBLIC_KEY, CRX_KEY_PATH, WXT_SENTRY_DSN, HCAPTCHA_SECRET, SMTP_PASS, TOKEN_SECRET, DATABASE_URL, DZ_DEBUG_API_KEY

## `layout` — gap

- migration to the house layout filed as tasks
- apps/ai-designer: 22 move(s) planned as one task

## `smoke_test` — ok

- test/unit/manifest-invariant.test.ts in the repository
- run by ./bin/check exited 0 at head (478.2s)

## `env_example` — ok

- .env.example already present, left alone

## `agents_md` — ok

- AGENTS.md established

## `per_workspace_brains` — ok

- single-package repository: 0 workspaces
- CLAUDE.md already present, left alone

## `docs_readme` — ok

- docs/README.md established

## `gate_proved` — ok

- ./bin/check exited 0 at head (478.2s)
