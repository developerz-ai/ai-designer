# Architecture

Top-level components and data flow. MV3 boundaries are load-bearing — keep DOM access, network, and UI in separate worlds.

## Components

```
┌─────────────────────── Chrome Extension (MV3) ───────────────────────┐
│                                                                       │
│  ┌──────────────┐      messages       ┌───────────────────────────┐  │
│  │ Side Panel   │◄───────────────────►│  Service Worker (bg)       │  │
│  │ (SolidJS)    │                     │  - Vercel AI SDK loop      │  │
│  │ - chat       │                     │  - OpenRouter client (key) │  │
│  │ - MCP mgmt   │                     │  - MCP clients (handoff)   │  │
│  │ - history    │                     │  - changeset store         │  │
│  └──────────────┘                     └───────────┬───────────────┘  │
│                                                    │ DOM tool calls    │
│                                       ┌────────────┴───────────────┐  │
│                                       │  Content Script            │  │
│                                       │  - DOM read/mutate         │  │
│                                       │  - overlay + element picker│  │
│                                       │  - screenshot/computed css │  │
│                                       │  - changeset recorder      │  │
│                                       └────────────┬───────────────┘  │
└────────────────────────────────────────────────────┼─────────────────┘
                                                       │ mutates
                                              ┌────────▼────────┐
                                              │  The live page   │
                                              └─────────────────┘

   Service Worker ──MCP──► ai-dev / developerz.ai ──► repo edit ──► PR
```

## Data flow — design

1. User types in the **side panel** chat → message to **service worker**.
2. Service worker runs the **agent loop** (Vercel AI SDK + OpenRouter).
3. Agent calls a **DOM tool** → message to **content script** → page mutates.
4. Content script returns result (new computed styles, screenshot) → agent → chat.
5. User accepts → **changeset** entry stored in service worker.

## Data flow — ship

1. User clicks **Ship** → service worker assembles the changeset.
2. Service worker opens an **MCP client** to the configured backend ([ai-dev](mcp.md)).
3. Calls `task(action: 'create', ...)` with the changeset as the task spec.
4. Dev-agent works the task (find source → edit → test → PR); status streams back.
5. Side panel shows task status + PR link.

## Why these boundaries

| Boundary | Reason |
|----------|--------|
| Keys only in service worker | Content scripts share the page's world — never expose the OpenRouter key there. |
| DOM only in content script | Service worker has no DOM. All page reads/writes proxied via messages. |
| UI in side panel (isolated) | Solid bundle runs in the extension origin, CSP-clean, survives page navigation. |
| Changeset in service worker | Survives page reloads; the content script's recorder reports up to it. |

## Persistence

- **Session changeset** — in-memory + `chrome.storage.session`. Cleared on tab close.
- **Settings** — `chrome.storage.local`: OpenRouter key (encrypted), MCP connections, model prefs.
- **No server.** v0/v1 are fully client-side except the MCP backend the user connects.

See [extension.md](extension.md) for the MV3 file layout, [live-edit.md](live-edit.md) for the recorder, [agent.md](agent.md) for the loop.
