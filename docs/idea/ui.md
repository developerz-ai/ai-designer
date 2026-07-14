# UI

SolidJS, prebuilt to a static bundle (CSP-clean MV3 — no runtime eval). SCSS with SRP: **one component = one `.tsx` + one co-located `.scss`**. Icons are self-hosted FontAwesome SVG (`Icon.tsx` + `icon-registry.ts`) — built from imported icon data, nothing fetched at runtime, no `innerHTML`.

## Surfaces

| Surface | Where | Contents |
|---------|-------|----------|
| Side panel | `chrome.sidePanel` | Readiness header + 4 tabs — survives navigation |
| Overlay | content script, shadow-DOM host | Element picker highlight + live agent-decision overlay |

## Side panel tabs

Four tabs (`Tab = 'chat' | 'mcp' | 'history' | 'settings'`) — there is no standalone "diff review" tab; the changeset lives inside the Chat flow.

- **Chat** — the design conversation. Mode picker (copy / debug / none), streamed tokens, tool-call chips, inline before/after thumbnails, the input box, and the **Ship bar** (Ship or Download report, per [handoff.md](handoff.md)).
- **MCP** — connected backends, auth status, origin→repo mapping, task status timelines + PR links. Feature-flagged, on by default. See [mcp.md](mcp.md).
- **History** — last 10 conversations (+ their reports/PR links). Selecting one swaps in a read-only replay; delete supported. See [Memory](agent.md#memory).
- **Settings** — provider config (base URL, API key, model picker), overlay opt-in.

## Readiness header

Always visible above the tabs: a status pill (Setup needed → Ready → Running…) that expands into a checklist (Provider, Model, Host permission, MCP backend — each with a "Fix →" link) plus a Start/Stop toggle and the on-page-overlay switch. See [agent.md](agent.md#readiness--start).

## Overlay

Two related, visually consistent surfaces, both drawn in a shadow-DOM host so page CSS can't leak either direction:

- **Element picker** — hover outline + floating pill (tag · dims · resolved selector · fragility badge). Click to focus; shift-click for multi-select.
- **Agent-decision overlay** (opt-in, off by default) — while a turn runs, mirrors each tool-call step live on the page: a compact card with the current step, a short scrolling log, and a highlight box on the element being acted on. `pointer-events: none` — never blocks the page. Reuses the picker's highlight so the on-page chrome reads as one Cursor-style system.

## Component map (SRP, selected)

| Component | Responsibility |
|-----------|----------------|
| `App.tsx` | Tab shell, readiness header, routing between Chat / MCP / History / Settings |
| `ReadinessDropdown.tsx` | Status pill, checklist, Start/Stop, overlay toggle |
| `ChatPanel.tsx` / `chat/Thread.tsx` | Message list + streaming render |
| `chat/ToolChip.tsx` | One tool call, status, expandable args |
| `chat/Composer.tsx` | Input, send, mode picker |
| `ShipBar.tsx` | Ship / Download report actions |
| `TaskTimeline.tsx` | Handoff status → PR link |
| `McpPanel.tsx` | Connected backends + add/remove + origin→repo mapping |
| `AuthDialog.tsx` | OAuth/PKCE + API-key entry |
| `HistoryPanel.tsx` / `ConversationView.tsx` | Last-10 list + read-only replay |
| `SettingsPanel.tsx` | Provider config + model picker |
| `Icon.tsx` / `icon-registry.ts` | Self-hosted FontAwesome SVG icons |

## Styling

- `_tokens.scss` — colors, spacing, type scale (one source of truth; theme-able).
- One `.scss` per component, imported by that component only — no global cascade surprises.
- Build emits a single static CSS + JS bundle WXT loads into the panel.

## State

- Solid stores under `src/entrypoints/sidepanel/stores/`: `chat`, `changeset`, `mcp`, `history`, `readiness`, `overlay`, `session`, `settings`, plus `bus`/`sw-stream` for the message-bus plumbing. Thin — they reflect service-worker state pushed over the [message bus](../architecture/mv3-worlds.md), they don't own the agent.
- The service worker is the source of truth (agent loop, changeset, MCP, history). The panel is a view.
