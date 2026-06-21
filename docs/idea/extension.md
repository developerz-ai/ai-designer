# Extension (Manifest V3)

Chrome MV3. Three execution worlds, strict separation. Built with [WXT](https://wxt.dev/) (or CRXJS) + Bun + TypeScript; UI is a prebuilt SolidJS bundle.

## Layout

```
src/
├── manifest.ts            # MV3 manifest (WXT generates)
├── entrypoints/
│   ├── background.ts      # service worker — agent loop, OpenRouter, MCP, changeset
│   ├── content.ts         # content script — DOM, overlay, picker, recorder
│   └── sidepanel/         # SolidJS app — chat + MCP management + diff review
│       ├── index.html
│       └── App.tsx
├── agent/                 # Vercel AI SDK loop, tool defs, prompts  → agent.md
├── dom/                   # mutation primitives, selector engine    → live-edit.md
├── changeset/             # recorder, schema, serializer            → handoff.md
├── mcp/                   # MCP client manager, auth                → mcp.md
└── shared/                # Zod schemas, message types (panel ↔ sw ↔ content)
```

## Manifest essentials

| Key | Value | Why |
|-----|-------|-----|
| `manifest_version` | 3 | Required. |
| `side_panel` | `sidepanel/index.html` | Persistent UI, survives page nav. |
| `background.service_worker` | `background.ts` (module) | Agent loop + key custody. |
| `content_scripts` | match `<all_urls>`, `run_at: document_idle` | DOM access on the active tab. |
| `permissions` | `sidePanel`, `storage`, `scripting`, `activeTab`, `tabs` | Minimal set. |
| `host_permissions` | opt-in per site (or `activeTab`) | Least privilege — no blanket grant. |
| `optional_host_permissions` | `<all_urls>` | User grants when they want it everywhere. |

## Messaging

Typed message bus over `chrome.runtime` / `chrome.tabs.sendMessage`. All payloads Zod-validated in `shared/`.

```
panel  ──UserMessage──►  sw   (start agent turn)
sw     ──DomTool──────►  content  (query / mutate / capture)
content──ToolResult───►  sw
sw     ──Stream───────►  panel    (tokens, tool calls, changeset updates)
sw     ──McpTask──────►  backend  (handoff)
```

## CSP / MV3 constraints

- **No remote code, no `eval`.** Solid is prebuilt to static JS — that's why we prebuild with Bun.
- **Service worker is ephemeral.** It can be killed; persist in-flight state to `chrome.storage.session`, resume on wake.
- **OpenRouter calls from the service worker only.** Content scripts run in the page's world — never put the key there.

## Why side panel (not popup / injected panel)

- Survives navigation and reloads — the design conversation outlives the page.
- Its own origin + CSP — safe place to run the Solid UI and hold no page trust.
- Doesn't fight the page's own z-index/styles the way an injected panel does.

See [architecture.md](architecture.md) for the world diagram, [ui.md](ui.md) for the Solid surfaces.
