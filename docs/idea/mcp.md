# MCP

Where work lands. The MCP management UI lets the user connect dev-agent backends; the extension dispatches the [handoff](handoff.md) there. The MCP client lives in the **service worker** (keys never touch the page).

## Supported backends

| Backend | URL | Use |
|---------|-----|-----|
| [tesote ai-dev](https://ai-dev.miamibeachstart.com/mcp) | `…/mcp` | Primary. Creates coding tasks → PRs. `task`, `kb`, `pr` tools. |
| developerz.ai | (per install) | Maintainer agent; handoff as an issue/PR task. |
| [GitHub MCP](https://github.com/github/github-mcp-server) | `https://api.githubcopilot.com/mcp` | Direct repo/PR ops when no orchestrator is used. |
| Custom | any HTTP-streamable MCP | User-added server URL. |

## Connecting

1. MCP tab → **Add server** → name + URL + transport (HTTP-streamable).
2. Authenticate (see below). On success, tool catalog is fetched and cached.
3. Map page origins → repos (e.g. `localhost:3000` → `acme/storefront`) for one-click [Ship](handoff.md).

## Auth

Mirrors ai-dev's auth model — three levels, checked in order by the backend:

| Level | How the extension presents it |
|-------|-------------------------------|
| Admin API key | `Authorization: Bearer <key>` — full access (self-host/dev). |
| Worker API key | per-worker key — agent tools only. |
| OAuth 2.0 (PKCE) / user token | Browser OAuth flow (PKCE required for public clients) or pasted `api_token` from the backend's profile page. |

- OAuth flow uses `chrome.identity.launchWebAuthFlow`; tokens stored encrypted in `chrome.storage.local`, refreshed in the service worker.
- BYOK throughout — we never proxy or resell access (see [principles.md](principles.md)).

## Tools at runtime

- **Handoff (write):** `task(action:'create')` / `watch` — the core path. See [handoff.md](handoff.md).
- **Design-time (read, optional):** if the backend exposes `kb` / repo search, the [agent](agent.md) can consult it *while designing* — "what design tokens does this repo define?" — so edits already match the codebase. Less guesswork at handoff.

## Namespacing

Tools from a connected server are namespaced `<server_name>__<tool>` to avoid collisions when multiple backends are attached (same convention ai-dev uses for third-party servers).

## Why the service worker

- Holds keys/tokens out of the page's world.
- One client per connected server, opened lazily, torn down on idle.
- Survives page navigation — the connection outlives the tab's content.
