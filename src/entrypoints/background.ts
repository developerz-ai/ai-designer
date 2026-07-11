import { defineBackground } from '#imports';
import {
  clearOpenRouterKey,
  getOpenRouterKey,
  hasOpenRouterKey,
  setOpenRouterKey,
} from '@/agent/key-store';
import { listModels, validateKey } from '@/agent/openrouter';
import { type Changeset, emptyChangeset } from '@/shared/changeset';
import type { SwToPanel } from '@/shared/messages';
import { ContentToSw, PanelToSw } from '@/shared/messages';
import { PORT_NAME } from '@/shared/port';
import { relayToPanel } from '@/shared/relay';
import { initSentry } from '@/shared/sentry';

// chrome.storage.local key for the (non-secret) selected model id.
const SELECTED_MODEL_KEY = 'selected-model';

// Service worker — the brain. Holds keys, runs the agent loop, owns MCP clients
// and the changeset store. NEVER expose the OpenRouter key to the content script
// (it shares the page's world). See docs/architecture/{components,security}.md.

export default defineBackground(() => {
  initSentry();

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
    for (const port of panelPorts) port.postMessage(msg);
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
    switch (msg.type) {
      case 'user-message':
        // TODO: run the Vercel AI SDK loop (src/agent), stream tokens + tool calls
        // to the panel, dispatch DomTool messages to the content script.
        return { ok: true };
      case 'ship':
        // TODO: assemble changeset -> open MCP client (src/mcp) -> task(create).
        return { ok: true };

      // --- settings / BYOK: key custody + OpenRouter network are SW-only ---
      case 'save-openrouter-key': {
        // Validate first (cheap ping); only persist a key that authenticates.
        const valid = await validateKey(msg.text);
        if (valid) await setOpenRouterKey(msg.text);
        return { ok: true, valid };
      }
      case 'list-models': {
        const models = await listModels(await getOpenRouterKey());
        return { ok: true, models };
      }
      case 'set-model':
        await chrome.storage.local.set({ [SELECTED_MODEL_KEY]: msg.model });
        return { ok: true };
      case 'key-status': {
        const got = await chrome.storage.local.get(SELECTED_MODEL_KEY);
        const model = got[SELECTED_MODEL_KEY];
        // Returns presence + selected model only — never the key value.
        return {
          ok: true,
          present: await hasOpenRouterKey(),
          model: typeof model === 'string' ? model : undefined,
        };
      }
      case 'clear-openrouter-key':
        await clearOpenRouterKey();
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
