# UI

SolidJS, prebuilt to a static bundle (CSP-clean MV3 — no runtime eval). SCSS with SRP: **one component = one `.tsx` + one co-located `.scss`**. Logo from `assets/logos/` (imported from developerz.ai branding).

## Surfaces

| Surface | Where | Contents |
|---------|-------|----------|
| Side panel | `chrome.sidePanel` | Chat tab, MCP tab, diff-review — survives navigation |
| Overlay | content script | Element picker highlight, selection chrome |

## Side panel tabs

- **Chat** — the design conversation. Streamed tokens, tool-call chips ("setStyle on .cta"), inline before/after thumbnails, the input box.
- **MCP** — connected backends, auth status, origin→repo mapping, task status timelines + PR links. See [mcp.md](mcp.md).
- **Diff review** — the current changeset as a list: intent, selector, changed props, before/after screenshots. Per-entry undo. **Ship** button lives here (see [handoff.md](handoff.md)).

## Element picker overlay

- Injected by the content script (see [live-edit.md](live-edit.md)).
- Hover highlight with tag + dims + resolved selector; fragility badge if the selector is brittle.
- Click to focus "this" for the agent; shift-click for multi-select.

## Component map (SRP)

| Component | Responsibility |
|-----------|----------------|
| `App.tsx` | Tab shell, routing between Chat / MCP / Diff |
| `Chat/Thread.tsx` | Message list + streaming render |
| `Chat/ToolChip.tsx` | One tool call, status, expandable args |
| `Chat/Composer.tsx` | Input, send, model picker |
| `Mcp/ServerList.tsx` | Connected backends + add/remove |
| `Mcp/AuthDialog.tsx` | OAuth/PKCE + API-key entry |
| `Mcp/TaskTimeline.tsx` | Handoff status → PR link |
| `Diff/ChangesetList.tsx` | Recorded edits, per-entry undo |
| `Diff/BeforeAfter.tsx` | Screenshot pair + style delta |
| `Diff/ShipButton.tsx` | Assemble + dispatch changeset |
| `shared/Logo.tsx` | Brand mark |

## Styling

- `_tokens.scss` — colors, spacing, type scale (one source of truth; theme-able).
- One `.scss` per component, imported by that component only — no global cascade surprises.
- Build emits a single static CSS + JS bundle WXT loads into the panel.

## State

- Solid stores: `chatStore`, `changesetStore`, `mcpStore`. Thin — they reflect service-worker state pushed over the [message bus](extension.md), they don't own the agent.
- The service worker is the source of truth (agent loop, changeset, MCP). The panel is a view.
