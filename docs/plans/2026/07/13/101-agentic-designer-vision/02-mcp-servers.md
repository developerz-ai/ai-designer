# 02 — MCP server management + auth

> Part of [`overview.md`](overview.md). Depends on: 01 (key-store named secrets). World: **service worker** (MCP client + tokens) + **side panel** (UI). Spec: `docs/idea/mcp.md`, `modelcontextprotocol.io/specification/2025-03-26/basic/transports`. Skill: `ship`.

## Why
Vision: "add mcp servers too custom … a link to do the oauth, or if they api key". Today `McpPanel.tsx` is a hidden static shell (`SHOW_MCP=false`), no `src/mcp`. Build real connect + auth + tool discovery. This is where copy/debug work lands (07).

## Files to change
- `src/mcp/client.ts` — **new**. `connect(server)` via `createMCPClient({ transport: { type:'http', url, headers } })` (`docs/reference/agent-sdk.md:96-108`); `client.tools()` discovery; namespaced `<serverId>__<tool>`; lazy open, close on idle/turn-end. **SW-only.**
- `src/mcp/manager.ts` — **new**. `McpManager`: registry of connected servers, health/tool-catalog cache, `toolsFor(agent)` merge. Referenced by `background.ts:112` TODO.
- `src/mcp/auth.ts` — **new**. Three levels (`docs/idea/mcp.md:22-31`): admin/worker API key → `Authorization: Bearer`; OAuth 2.0 **PKCE** via `chrome.identity.launchWebAuthFlow`, token refresh in SW. Tokens stored via `key-store.setSecret('mcp:<id>:token')`.
- `src/mcp/store.ts` — **new**. Persist server list (`{id,label,url,transport,authKind}` non-secret) in `chrome.storage.local`; secrets via key-store.
- `src/shared/messages.ts` — add `McpServer` schema + RPCs: `mcp-add`, `mcp-remove`, `mcp-list`, `mcp-connect`, `mcp-auth-start` (returns OAuth URL), `mcp-status`. Add `mcp-status` to `SwToPanel` stream for live connection state.
- `src/entrypoints/background.ts:112` — instantiate `McpManager`; wire the RPCs; on `mcp-add` request `optional_host_permissions` for the server origin.
- `src/entrypoints/sidepanel/App.tsx:11,30-38` — flip `SHOW_MCP` on; MCP is a real tab.
- `src/entrypoints/sidepanel/components/McpPanel.tsx:1-45` + `.scss` — rebuild: server list w/ connect/auth status + PR/task timeline slot; **Add server** form (name + URL + transport). Keep `DEFAULT_BACKENDS` as presets (ai-dev, developerz.ai, GitHub MCP `mcp.md:6-13`).
- `src/entrypoints/sidepanel/components/AuthDialog.tsx` + `.scss` — **new**. API-key entry OR "Authorize" button (opens OAuth). SRP: dispatches to store only.
- `src/entrypoints/sidepanel/stores/mcp.ts` — **new**. `mcpStore` reflecting SW state via bus + stream (thin; SW is source of truth).

## Steps
1. `messages.ts`: `McpServer` + `AuthKind = 'apikey'|'oauth'|'none'` + RPCs + stream event.
2. `src/mcp/auth.ts`: implement PKCE (code_verifier/challenge, `launchWebAuthFlow` redirect back to extension), API-key path; persist tokens via key-store; refresh helper.
3. `src/mcp/client.ts` + `manager.ts`: connect/discover/namespace/close; expose `toolsFor()` returning an AI SDK `ToolSet` (consumed in `04`).
4. Wire SW RPCs (`background.ts`); permission request on add.
5. UI: enable tab, rebuild `McpPanel`, add `AuthDialog`, `mcpStore`. FontAwesome icons (10) for connected/error/auth states.
6. Add design-time read-tool consult path stub (agent may call `kb`/repo-search at design time — `mcp.md:34-37`); full use in `06`.

## Tests
- Unit: PKCE challenge derivation; namespacing `<id>__<tool>`; `mcp/store` round-trip; `messages` MCP schemas.
- Integration: `mcp-add` → `mcp-list` → `mcp-status` through the bus with a mock MCP HTTP server (route-stub tool discovery).
- E2E: add a stubbed server, show it Connected, list its tools. (OAuth flow: mock/skip `launchWebAuthFlow` — assert the URL is built, don't drive the browser dialog.)
- `bun run typecheck`, `bun run lint`.

## Done when
- User adds a custom HTTP-streamable MCP server; authenticates via API key or OAuth-PKCE; tools discovered + namespaced + cached.
- Server list + connection status persist; tokens encrypted, SW-only; host permission requested on add.
- `McpManager.toolsFor()` ready for the agent loop (04). Gate green.
