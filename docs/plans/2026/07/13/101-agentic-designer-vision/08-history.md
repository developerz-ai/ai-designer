# 08 — History: last-10 conversations + reports

> Part of [`overview.md`](overview.md). Depends on: 04 (turns), 07 (reports). World: **service worker** (persist) + **side panel** (SPA view). Spec: `.codegraph/vision.txt` ("last 10 conversations with ai and their reports").

## Why
Nothing is persisted — chat is an ephemeral signal (`ChatPanel.tsx:13`). Persist the last 10 conversations with their produced reports/PR links so the user can revisit them.

## Files to change
- `src/agent/history-store.ts` — **new** (SW). Ring buffer of the **last 10** `Conversation` = `{ id, title, url, mode, createdAt, messages, report?, prLink? }` in `chrome.storage.local` (bounded size — trim messages/screenshots to stay under quota; store report as MD text, not images). Append on turn-done; update on ship/report (07). **No timestamps from `Date.now()` in tests** — inject a clock.
- `src/shared/messages.ts` — add RPCs `history-list` (summaries), `history-get(id)`, `history-delete(id)`; `Conversation` schema.
- `src/entrypoints/background.ts` — persist each completed turn; wire history RPCs.
- `src/entrypoints/sidepanel/stores/history.ts` — **new**. Thin store over the RPCs.
- `src/entrypoints/sidepanel/components/HistoryPanel.tsx` + `.scss` — **new**. SPA-style list of the 10 (title, site favicon, mode badge, date, report/PR link); click → open a read-only conversation view; delete. FontAwesome icons (10).
- `src/entrypoints/sidepanel/components/ConversationView.tsx` + `.scss` — **new**. Read-only replay of a stored conversation + its report (download again).
- `src/entrypoints/sidepanel/App.tsx` — add a History entry point (header icon or tab) opening the SPA.

## Steps
1. `history-store.ts`: ring buffer (cap 10), size-bounded serialization; injectable clock.
2. Schemas + SW RPCs + persist-on-turn-done + update-on-ship.
3. `history` store + `HistoryPanel` + `ConversationView` (SRP; render + dispatch only).
4. Re-download a past report via blob URL (reuse 07 mechanism).

## Tests
- Unit: ring-buffer cap (11th evicts oldest); size-bounding; `Conversation` schema; clock injection (deterministic, no `Date.now()`).
- Integration: turn-done → history-list shows it; ship → PR link updates the entry; delete removes it.
- E2E: run 2 turns → both appear in History → open one → replay + re-download report.
- `bun run typecheck`, `bun run lint`.

## Done when
- The last 10 conversations (with reports/PR links) persist across reloads, oldest evicted at 11.
- History SPA lists, opens (read-only replay), re-downloads, and deletes entries. Gate green.
