# Evidence-first diagnostics

**Rule.** Real-time diagnostics evidence must survive service-worker restart. Cross-world emits (content script → service worker) are fire-and-forget: they must be buffered per tab, then drained into the turn's diagnostics evidence at turn start / before report build — never dropped because the worker was starting or evicted.

| Element | What it is |
|---|---|
| `ContentToSw` member `diagnostics-signal` | `src/shared/messages.ts:1886` — the content collector's push, one `CollectorSignal` per page signal |
| `emit` swallow | `src/entrypoints/content.ts:115-117` — `chrome.runtime.sendMessage(msg).catch(() => {})` swallows every send failure |
| Missing SW handler | background.ts's content.message listener had no `diagnostics-signal` case — the push landed nowhere |
| Fix | `src/changeset/pending-diagnostics.ts` per-tab FIFO buffer + `src/changeset/pending-diagnostics-persist.ts` chrome.storage.session mirror; background.ts buffers per tab on `diagnostics-signal`, drains at turn start into `turnDiagnostics`, folded into diagnostics ReportInput via `diagnose` |
| Metrics moved | `team_evidence_blocked_rate` below the 4 noise floor; the buffered/drained path explains the 5.2 reading |

## Why this rule exists

A debug-mode turn observed nothing until its own `diagnostics` DomTool pull ran. Real-time signals streamed while the SW was starting/evicted were dropped twice: once by content.ts's `emit` swallow (`sendMessage` rejection swallowed; `relayToPanel` returns null for the type), once because background.ts had no `diagnostics-signal` handler. That two-way drop is the cause behind the 5.2 reading. `test/unit/pending-diagnostics.test.ts` reproduces the buffer: it fails before the fix module exists and passes after.

## How to comply

Before a merge touches the emit path or the content.message listener: any fire-and-forget cross-world emit whose evidence must survive an SW restart must route through a per-tab buffer + persistence mirror, and the SW must drain that buffer into the turn's evidence before `makeReport`. Record the gotcha in this file. Root `CLAUDE.md`, `.dz/schedules/`, `census-corpus.ts` and `census-metrics.ts` stay untouched — this file is the steering write.
