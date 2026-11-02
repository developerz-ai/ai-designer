# UI

SolidJS, prebuilt to a static bundle (CSP-clean MV3 — no runtime eval). SCSS with SRP: **one component = one `.tsx` + one co-located `.scss`**. Icons are self-hosted FontAwesome SVG (`Icon.tsx` + `icon-registry.ts`) — built from imported icon data, nothing fetched at runtime, no `innerHTML`.

## Surfaces

| Surface | Where | Contents |
|---------|-------|----------|
| Side panel | `chrome.sidePanel` | Readiness header + 4 tabs — survives navigation |
| Overlay | content script, shadow-DOM host | Element picker highlight + live agent-decision overlay |

## Side panel tabs

Four tabs (`Tab = 'chat' | 'mcp' | 'history' | 'settings'`) — there is no standalone "diff review" tab; the changeset lives inside the Chat flow.

- **Chat** — the design conversation. Modes (copy / debug / none) are pinned per message or inferred from its text — suggestion chips, no picker UI. Streamed tokens, tool-call chips, the picked-element context chip, the input box, task status timelines + PR links after a Ship, and the **Ship bar** (Ship or Download report, per [handoff.md](handoff.md)).
- **MCP** — connected backends, auth status (API key / OAuth per server). Feature-flagged, on by default. The origin→repo mapping is storage-only today (no UI — see #20). See [mcp.md](mcp.md).
- **History** — last 10 conversations (+ their reports/PR links). Selecting one swaps in a read-only replay; delete supported. See [Memory](agent.md#memory) and [History](#history).
- **Settings** — provider config (base URL, API key, model picker), overlay opt-in.

## History

The last 10 conversations, kept as a ring buffer in `chrome.storage.local` (`src/agent/history-store.ts`) — newest first, the 11th push evicts the oldest. Service-worker only: the panel reaches it over the typed bus, never storage directly.

What one persisted conversation keeps:

| Kept | Shape |
|------|-------|
| Thread | The message thread — screenshots stripped to `[image omitted from history]`, other long strings truncated |
| Report | A finished session's brief as rendered Markdown text — never raw images |
| PR link | The URL a Ship opened, when the session shipped one |

Three RPCs carry it across the bus (`src/shared/messages.ts`):

| RPC | Carries |
|-----|---------|
| `history-list` | Summaries — title, URL, mode, timestamp, message count, report flag |
| `history-get(id)` | The full record — thread, report, PR link |
| `history-delete(id)` | Removes one conversation |

The panel surface: selecting a conversation swaps in a read-only replay of the thread — no new chat, no re-applied edits. The report can be re-downloaded as a `.md` file, the PR link opens in a new tab, and every row has a delete action. User-facing guide: [wiki/history.md](../wiki/history.md).

## Readiness header

Always visible above the tabs: a status pill (Setup needed → Ready → Running…) that expands into a checklist (Provider, Model, API key, Host permission, Page access, MCP backend — a "Fix →" deep-link each, except Page access, which grants in place) plus a Start/Stop toggle and the on-page-overlay switch. The pill is green with no spinner while a session is open: an open session is a state, not a wait — the Stop button next to it is what says the session is live. See [agent.md](agent.md#readiness--start).

## Overlay

Two related, visually consistent surfaces, both drawn in a shadow-DOM host so page CSS can't leak either direction:

- **Element picker** — hover outline + floating pill (tag · dims · resolved selector · fragility badge). Click to focus; shift-click for multi-select.
- **Agent-decision overlay** (opt-in, off by default) — while a turn runs, mirrors each tool-call step live on the page: a compact card with the current step, a short scrolling log, and a highlight box on the element being acted on. `pointer-events: none` — never blocks the page. Reuses the picker's highlight so the on-page chrome reads as one Cursor-style system. Top frame only, addressed at `frameId: 0`, and **ACKed**: the content script is manifest-injected at `document_idle`, so a tab open since before the extension was installed or last reloaded has none — the toggle push is then unanswered and the panel says "reload the page" instead of showing a confident On over a page that will never paint it.

## Component map (SRP, selected)

| Component | Responsibility |
|-----------|----------------|
| `App.tsx` | Tab shell, readiness header, routing between Chat / MCP / History / Settings |
| `ReadinessDropdown.tsx` | Status pill, checklist, Start/Stop, overlay toggle |
| `ChatPanel.tsx` / `chat/Thread.tsx` | Message list + streaming render |
| `chat/ToolChip.tsx` | One tool call, status, expandable args |
| `chat/Composer.tsx` | Input, send/stop, model quick-switch, attach-element picker trigger, reference-image attach (button / paste / drop) |
| `chat/AttachmentTray.tsx` | Attached mockups + promoted big pastes, above the composer shell |
| `ShipBar.tsx` | Ship / Download report actions |
| `TaskTimeline.tsx` | Handoff status → PR link |
| `McpPanel.tsx` | Connected backends + add/remove (origin→repo mapping is storage-only, no UI — #20) |
| `AuthDialog.tsx` | OAuth/PKCE + API-key entry |
| `HistoryPanel.tsx` / `ConversationView.tsx` | Last-10 list + read-only replay |
| `SettingsPanel.tsx` | Provider config + model picker |
| `Icon.tsx` / `icon-registry.ts` | Self-hosted FontAwesome SVG icons |

## Styling

- `_tokens.scss` — colors, spacing, type scale (one source of truth; theme-able).
- One `.scss` per component, imported by that component only — no global cascade surprises.
- Build emits a single static CSS + JS bundle WXT loads into the panel.

## State

- Solid stores under `src/entrypoints/sidepanel/stores/`: `chat`, `changeset`, `focus`, `mcp`, `history`, `readiness`, `overlay`, `session`, `settings`, plus `bus`/`sw-stream` for the message-bus plumbing. Thin — they reflect service-worker state pushed over the [message bus](../architecture/mv3-worlds.md), they don't own the agent.
- The service worker is the source of truth (agent loop, changeset, MCP, history). The panel is a view.
