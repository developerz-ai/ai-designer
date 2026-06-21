---
name: mv3
description: Manifest V3 extension gotchas — the three execution worlds, key custody, CSP / no-remote-code, the ephemeral service worker, and the typed message bus. Use when touching the manifest, wxt.config.ts, entrypoints, cross-world messaging, or when something behaves differently in the extension than in tests.
---

Three worlds, strict separation (load-bearing). See `docs/idea/extension.md`, `docs/architecture/mv3-worlds.md`.

| World | File | Has | NEVER has |
|-------|------|-----|-----------|
| Service worker | `src/entrypoints/background.ts` | keys, network, agent loop, MCP, changeset store | DOM |
| Content script | `src/entrypoints/content.ts` | DOM, picker, recorder | keys, tokens, network to model/MCP |
| Side panel | `src/entrypoints/sidepanel/` | SolidJS UI (own origin, CSP-clean) | page trust |

## Hard rules

- **Keys + network ONLY in the service worker.** A content script shares the page's world — exposing the OpenRouter key or MCP token there leaks it to the page.
- **DOM ONLY in the content script.** The SW has no DOM; proxy every page read/write over the bus.
- **No remote code, no `eval`.** Solid is prebuilt to static JS — that's why we prebuild with Bun/WXT.
- **The service worker is ephemeral.** It gets killed. Persist in-flight state to `chrome.storage.session`; rehydrate on wake. Never assume an in-memory `Map` survives.
- **Bus is typed.** All `panel ↔ sw ↔ content` messages are Zod-validated in `src/shared/messages.ts`. No `any` across the bus.

## Permissions

Least privilege. `host_permissions` opt-in per site (or `activeTab`); broad access via `optional_host_permissions` the user grants. Don't add a permission without a reason.
