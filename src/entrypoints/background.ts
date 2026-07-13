import { defineBackground } from '#imports';
import {
  clearProviderConfig,
  getProviderConfig,
  hasProviderKey,
  migrateLegacyProvider,
  saveProviderConfig,
} from '@/agent/config-store';
import { getOpenRouterKey, setOpenRouterKey } from '@/agent/key-store';
import { listModels, validateProvider } from '@/agent/provider';
import { headerResolverFor, saveApiKey, startOAuth } from '@/mcp/auth';
import type { McpConnectionSpec } from '@/mcp/client';
import { McpManager } from '@/mcp/manager';
import { getServer, listServers, removeServer, type StoredServer, saveServer } from '@/mcp/store';
import { type Changeset, emptyChangeset } from '@/shared/changeset';
import { ensureHostAccess } from '@/shared/host-permissions';
import type { McpOAuthConfig, McpServer, SwToPanel } from '@/shared/messages';
import { ContentToSw, PanelToSw } from '@/shared/messages';
import { PORT_NAME } from '@/shared/port';
import { relayToPanel } from '@/shared/relay';
import { initSentry } from '@/shared/sentry';

// The preset the legacy OpenRouter-only RPCs (save-openrouter-key/set-model) map onto.
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// Service worker — the brain. Holds keys, runs the agent loop, owns MCP clients
// and the changeset store. NEVER expose the OpenRouter key to the content script
// (it shares the page's world). See docs/architecture/{components,security}.md.

export default defineBackground(() => {
  initSentry();

  // Port a pre-ProviderConfig OpenRouter install into the named-secret scheme before any
  // settings RPC reads state. `handle` awaits this so a save/read can't race the migration.
  const migrated = migrateLegacyProvider().catch(() => {
    // Migration is best-effort: a failure just leaves the legacy key un-ported (the user can
    // re-enter it). Swallow so it never rejects an unrelated settings RPC.
  });

  // Per-tab design session changeset. Rehydrated from chrome.storage.session on wake.
  const sessions = new Map<number, Changeset>();

  // MCP registry (slice 02). OAuth endpoint configs aren't persisted (mcp/store.ts's
  // StoredServer is intentionally non-secret + config-free) — cached here for the SW's
  // lifetime so a refresh can re-derive headers without the panel resupplying them each
  // open; lost on SW restart, which just degrades `getAccessToken` to the stale token
  // (see mcp/auth.ts) until the user re-authorizes.
  const mcpManager = new McpManager();
  const oauthConfigs = new Map<string, McpOAuthConfig>();

  function mcpSpec(stored: StoredServer): McpConnectionSpec {
    return {
      id: stored.id,
      url: stored.url,
      getHeaders: headerResolverFor({
        id: stored.id,
        authKind: stored.authKind,
        oauth: oauthConfigs.get(stored.id),
      }),
    };
  }

  function toBusServer(stored: StoredServer): McpServer {
    const health = mcpManager.health(stored.id);
    return {
      id: stored.id,
      label: stored.label,
      url: stored.url,
      transport: stored.transport,
      authKind: stored.authKind,
      status: health?.status ?? 'disconnected',
      toolCount: health?.toolCount ?? 0,
      tools: health?.tools ?? [],
      error: health?.error,
    };
  }

  function pushMcpStatus(stored: StoredServer): void {
    postToPanel({ type: 'mcp-status', server: toBusServer(stored) });
  }

  // Rehydrate the registry from the persisted server list before any RPC is served.
  // Registration is cheap/lazy (client.ts doesn't open until `tools()`/`connect()`).
  const mcpReady = listServers().then((stored) => {
    for (const s of stored) mcpManager.register(mcpSpec(s));
  });

  const panelPorts = new Set<chrome.runtime.Port>();
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    panelPorts.add(port);
    port.onDisconnect.addListener(() => {
      panelPorts.delete(port);
    });
  });

  function postToPanel(msg: SwToPanel): void {
    for (const port of panelPorts) {
      try {
        port.postMessage(msg);
      } catch {
        // Port disconnected before its onDisconnect fired — drop it so one dead
        // panel can't abort the fan-out to the others.
        panelPorts.delete(port);
      }
    }
  }

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const parsed = PanelToSw.safeParse(raw);
    if (!parsed.success) return; // ignore foreign messages

    const tabId = sender.tab?.id;
    handle(parsed.data, tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response
  });

  async function handle(msg: PanelToSw, _tabId?: number) {
    await migrated; // settings reads must see the migrated (named-secret) state
    await mcpReady; // mcp-* cases need the registry rehydrated from storage
    switch (msg.type) {
      case 'user-message':
        // TODO: run the Vercel AI SDK loop (src/agent), stream tokens + tool calls
        // to the panel, dispatch DomTool messages to the content script.
        return { ok: true };
      case 'ship':
        // TODO: assemble changeset -> open MCP client (src/mcp) -> task(create).
        return { ok: true };

      // --- settings / BYOK: key custody + provider network are SW-only ---
      // Persist any openai-compatible provider. A custom host needs a runtime grant first
      // (CORS); a denial is surfaced without persisting. We persist before validating so an
      // offline local endpoint still saves — `valid` reports reachability, informational.
      case 'save-provider': {
        const access = await ensureHostAccess(msg.config.baseURL);
        if (!access.ok) return { ok: true, valid: false, error: access.error };
        await saveProviderConfig(msg.config);
        const saved = await getProviderConfig(); // includes the decrypted key (new or kept)
        const result = saved ? await validateProvider(saved) : { ok: false, error: undefined };
        return { ok: true, valid: result.ok, error: result.error };
      }
      // Presence + non-secret config only — never the key value (apiKey is stripped here).
      case 'get-provider': {
        const cfg = await getProviderConfig();
        const config = cfg
          ? { baseURL: cfg.baseURL, model: cfg.model, label: cfg.label }
          : undefined;
        return { ok: true, config, hasKey: await hasProviderKey() };
      }
      // baseURL-aware: an explicit endpoint (setup, pre-save) wins; otherwise the saved
      // config, falling back to the OpenRouter preset + any stored key (legacy caller).
      case 'list-models': {
        const endpoint = msg.baseURL
          ? { baseURL: msg.baseURL, apiKey: msg.apiKey }
          : ((await getProviderConfig()) ?? {
              baseURL: OPENROUTER_BASE_URL,
              apiKey: (await getOpenRouterKey()) ?? undefined,
            });
        const models = await listModels(endpoint);
        return { ok: true, models };
      }

      // --- legacy OpenRouter-only RPCs: mapped onto ProviderConfig for back-compat until
      // the panel moves to save-provider/get-provider (next slice). ---
      case 'save-openrouter-key': {
        const { ok: valid, error } = await validateProvider({
          baseURL: OPENROUTER_BASE_URL,
          apiKey: msg.text,
        });
        if (valid) await setOpenRouterKey(msg.text); // shared `provider:default:key` slot
        return { ok: true, valid, error };
      }
      case 'set-model': {
        // Set the model on the current config (OpenRouter preset if none), preserving the
        // stored key via the apiKey-omitted save path.
        const cfg = await getProviderConfig();
        await saveProviderConfig({
          baseURL: cfg?.baseURL ?? OPENROUTER_BASE_URL,
          label: cfg?.label,
          model: msg.model,
        });
        return { ok: true };
      }
      case 'key-status': {
        const cfg = await getProviderConfig();
        return { ok: true, present: await hasProviderKey(), model: cfg?.model };
      }
      case 'clear-openrouter-key':
        await clearProviderConfig();
        return { ok: true };

      // --- MCP servers: registry + auth are SW-only (tokens/headers never reach content) ---
      // Add + persist a server; request the origin's host permission first (same
      // optional_host_permissions pattern as save-provider) so a denied grant never
      // persists an unreachable config.
      case 'mcp-add': {
        const access = await ensureHostAccess(msg.url);
        if (!access.ok) return { ok: false, error: access.error };
        const stored = await saveServer({
          id: crypto.randomUUID(),
          label: msg.label,
          url: msg.url,
          transport: msg.transport,
          authKind: msg.authKind,
        });
        mcpManager.register(mcpSpec(stored));
        pushMcpStatus(stored);
        return { ok: true, server: toBusServer(stored) };
      }
      // Tear down the connection and purge the persisted record + both credential slots
      // (mcp/store.ts removeServer already clears the key-store side).
      case 'mcp-remove': {
        await mcpManager.unregister(msg.id);
        oauthConfigs.delete(msg.id);
        await removeServer(msg.id);
        return { ok: true };
      }
      case 'mcp-list': {
        const servers = (await listServers()).map(toBusServer);
        return { ok: true, servers };
      }
      // (Re)open a registered server and refresh its cached health/tool catalog.
      // McpManager.connect never throws — a failed open comes back as status:'error'.
      case 'mcp-connect': {
        const stored = await getServer(msg.id);
        if (!stored) return { ok: false, error: `Unknown MCP server: ${msg.id}` };
        if (!mcpManager.has(msg.id)) mcpManager.register(mcpSpec(stored));
        await mcpManager.connect(msg.id);
        pushMcpStatus(stored);
        return { ok: true, server: toBusServer(stored) };
      }
      // Submit the chosen auth kind's credential, then reconnect so the new header takes
      // effect immediately. `authKind` on the record is updated to match what was just
      // authorized (an add can predate its auth step with authKind left at the default).
      case 'mcp-auth-start': {
        const stored = await getServer(msg.id);
        if (!stored) return { ok: false, error: `Unknown MCP server: ${msg.id}` };
        try {
          if (msg.authKind === 'apikey') {
            await saveApiKey(msg.id, msg.apiKey);
          } else {
            oauthConfigs.set(msg.id, msg.oauth);
            await startOAuth(msg.id, msg.oauth);
          }
        } catch (err) {
          return { ok: false, error: String(err) };
        }
        const next = await saveServer({ ...stored, authKind: msg.authKind });
        mcpManager.register(mcpSpec(next));
        await mcpManager.connect(msg.id);
        pushMcpStatus(next);
        return { ok: true, server: toBusServer(next) };
      }
      // Manual refresh: republish every registered server's current health on the
      // mcp-status stream (e.g. a panel that just (re)connected with no cached state).
      case 'mcp-status': {
        for (const stored of await listServers()) pushMcpStatus(stored);
        return { ok: true };
      }
    }
  }

  // Content -> SW push (fire-and-forget forwarding to the panel; no response).
  chrome.runtime.onMessage.addListener((raw) => {
    const parsed = ContentToSw.safeParse(raw);
    if (!parsed.success) return; // PanelToSw RPC handled by the listener above

    // Pure mapping lives in src/shared/relay.ts (testable; entrypoints are
    // coverage-excluded). null = no panel consumer for this event yet.
    const out = relayToPanel(parsed.data);
    if (out) postToPanel(out);
  });

  void sessions;
  void emptyChangeset;
});
