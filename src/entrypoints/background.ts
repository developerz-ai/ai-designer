import { defineBackground } from '#imports';
import { type Changeset, emptyChangeset } from '@/shared/changeset';
import { PanelToSw } from '@/shared/messages';

// Service worker — the brain. Holds keys, runs the agent loop, owns MCP clients
// and the changeset store. NEVER expose the OpenRouter key to the content script
// (it shares the page's world). See docs/architecture/{components,security}.md.

export default defineBackground(() => {
  // Per-tab design session changeset. Rehydrated from chrome.storage.session on wake.
  const sessions = new Map<number, Changeset>();

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
    }
  }

  // TODO: getOpenRouterKey() from chrome.storage.local (encrypted), guard agent loop.
  // TODO: mcpManager — open/close MCP clients per configured backend (src/mcp).
  void sessions;
  void emptyChangeset;
});
