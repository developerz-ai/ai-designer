import { defineBackground } from '#imports';
import {
  clearProviderConfig,
  getProviderConfig,
  hasProviderKey,
  migrateLegacyProvider,
  saveProviderConfig,
} from '@/agent/config-store';
import { ensureHostAccess } from '@/agent/host-permissions';
import { getOpenRouterKey, setOpenRouterKey } from '@/agent/key-store';
import { listModels, validateProvider } from '@/agent/provider';
import { type Changeset, emptyChangeset } from '@/shared/changeset';
import type { SwToPanel } from '@/shared/messages';
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

  // TODO: mcpManager — open/close MCP clients per configured backend (src/mcp).
  void sessions;
  void emptyChangeset;
});
