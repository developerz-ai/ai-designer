# Brief: improvement

Fired on the first and third Monday of each month by `schedules: improve` (`weeks_of_month: [1, 3]`).

Twice a month, leave the extension measurably better. `CLAUDE.md` binds every change, and `non_goals` in the policy file are off limits. A red `main`
and a missing publish belong to the platform's red-main ask and the owner (publishing). A Dependabot PR
whose checks have failed for seven days is item 2 below: the scheduled `health` check that used to escalate it was retired on 2026-11-28.

## Signals

| Signal | Command |
|---|---|
| the gate on fresh `main` | `bun run verify` |
| dependency majors | `bun outdated` |
| open bugs | `gh issue list --state open --label bug --json number,title,url` |

## Pick at most three, in this order

1. Anything the gate found broken or flaky: the root cause, never a retry or a skip.
2. Dependency majors Dependabot could not land, and Dependabot PRs red for seven days, one per PR.
3. Open bugs, each starting from a test that fails on `main`.
4. Docs that no longer match the code, then dead code.

## Ship

One small PR per improvement, its evidence in the body, `bun run verify` green first. Never bump the version or touch release or store automation here.
Check no open PR or issue already covers it. If nothing is worth changing, do nothing: no empty PRs, no churn.

## Rows

- `gate` — First: run `bun run verify` on fresh `main`; address anything broken or flaky at its root cause, never with a retry or a skip.
- `dependency-majors` — Second: use `bun outdated` to identify dependency majors Dependabot could not land, and `gh pr list --author app/dependabot --json number,updatedAt,statusCheckRollup` for Dependabot PRs whose checks have failed for seven days (any bump size); one per PR.
- `open-bugs` — Third: use `gh issue list --state open --label bug --json number,title,url`; each bug starts from a test that fails on `main`.
- `stale-docs` — Fourth: docs that no longer match the code.
- `dead-code` — After stale docs: dead code.
