# Standards

Rules that apply to every change in this repository, written where the fleet reads them.

| Rule | What it covers |
|---|---|
| [Gotcha capture](gotcha-capture.md) | Bot-authored code merges record their gotchas in a steering file under this directory. |
| [Evidence-first diagnostics](evidence-first.md) | Real-time diagnostics evidence must survive service-worker restart: buffer per tab, persist, drain into the turn before report build. |
| [Hold idempotency](hold-idempotency.md) | Every cross-boundary task dispatch carries a stable idempotency key derived from changeset.sessionId and is watched to terminal or explicitly failed; held tasks are never hidden or redefined. |
| [Retry-storm prevention](retry-storm-prevention.md) | A keyless retried or doubled `task(create)` mints duplicate tasks that repeatedly fail and age held; carry a stable session-derived idempotency key and watch every create to terminal or explicit failure. |

A write under `docs/standards/` is a steering write in the health checkup. The root `CLAUDE.md`
and `.dz/schedules/` are not edited by these rules: they belong to the maintainers and the
platform.
