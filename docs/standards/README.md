# Standards

Rules that apply to every change in this repository, written where the fleet reads them.

| Rule | What it covers |
|---|---|
| [Gotcha capture](gotcha-capture.md) | Bot-authored code merges record their gotchas in a steering file under this directory. |
| [Evidence-first diagnostics](evidence-first.md) | Real-time diagnostics evidence must survive service-worker restart: buffer per tab, persist, drain into the turn before report build. |

A write under `docs/standards/` is a steering write in the health checkup. The root `CLAUDE.md`
and `.dz/schedules/` are not edited by these rules: they belong to the maintainers and the
platform.
