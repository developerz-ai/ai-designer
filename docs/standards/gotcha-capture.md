# Gotcha capture on bot code merges

**Rule.** Every bot-authored code or configuration merge in `developerz-ai/ai-designer` writes its
gotchas into a steering file under `docs/standards/` in the same merge. Name that file in the PR
description. A dependency-only bump (manifest or lockfile version only) is exempt.

| Merge shape | Gotcha write |
|---|---|
| Bot code or config change, including site and extension source | Required under `docs/standards/` |
| Dependency-only bump (manifest and lockfile versions) | Exempt |
| Documentation-only change | Exempt |

## Why this rule exists

The health checkup recorded 0.0% gotcha capture in both 7-day windows ending 2026-11-20: zero
steering writes across 18 merges in the current window and 9 in the previous one. Dependency share
rose from 77.8% to 88.9% over the same span. The only two non-dependency bot code merges in the
current window wrote no steering file:

| Merge | Files | Steering write |
|---|---|---|
| #260 (`de98fa0`) | `site/src/main.ts`, `site/src/vite-env.d.ts`, `site/src/world/world.ts` | none |
| #261 (`5a9bcb9`) | `site/Dockerfile`, `site/index.html`, `site/package.json`, `site/privacy.html`, `site/vite.config.ts`, `site/world.html` | none |

Those are missed captures, not just a changed mix of merges. Each merge had a gotcha worth
recording: the CTA swap and the waitlist retirement both changed which page the install button
points at, and neither left a note for the next agent that touches the funnel.

## What counts as a steering write

The census counts a write to `docs/standards/`, `.claude/`, `.cursor/rules/`, `CLAUDE.md` or
`AGENTS.md`. This rule asks for `docs/standards/` specifically: the gotcha sits beside the rule it
refines, and root `CLAUDE.md` plus `.dz/schedules/` stay untouched.

## How to comply

Record in the steering file, before merging:

- the gotcha the merge exposed, that is what looked right but was not
- the rule that prevents a repeat
- the PR that surfaced it

`test/unit/gotcha-capture-rule.test.ts` reproduces the #260 and #261 misses, and fails if this rule
file disappears or loses its markers.
