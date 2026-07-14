import { generateText } from 'ai';
import { defineBackground } from '#imports';
import { type BrowseTabDriver, runBrowse } from '@/agent/browse-tab';
import { type BrowserControlDriver, runFrames, runNav, runTabs } from '@/agent/browser-control';
import {
  clearProviderConfig,
  getProviderConfig,
  hasProviderKey,
  migrateLegacyProvider,
  saveProviderConfig,
} from '@/agent/config-store';
import { getOpenRouterKey, setOpenRouterKey } from '@/agent/key-store';
import { runTurn } from '@/agent/loop';
import { modeGuidance, resolveMode } from '@/agent/modes';
import { createProvider, listModels, validateProvider } from '@/agent/provider';
import { computeReadiness } from '@/agent/readiness';
import { SessionStore } from '@/agent/session';
import { buildSystemPrompt } from '@/agent/system-prompt';
import type { ScreenshotDispatch } from '@/agent/tools/vision';
import { type GenerateVision, runDescribeScene, runInspect } from '@/agent/vision';
import { cropBox, planStitch, type StitchPlan } from '@/dom/read';
import { headerResolverFor, saveApiKey, startOAuth } from '@/mcp/auth';
import type { McpConnectionSpec } from '@/mcp/client';
import { McpManager } from '@/mcp/manager';
import { getServer, listServers, removeServer, type StoredServer, saveServer } from '@/mcp/store';
import { ensureHostAccess } from '@/shared/host-permissions';
import type {
  CaptureResult,
  ControlTool,
  DescribeCmd,
  DesignRead,
  DesignReadRequest,
  DomTool,
  McpOAuthConfig,
  McpServer,
  PageMetrics,
  PageMetricsRequest,
  PickerCmd,
  Rect,
  SwToPanel,
} from '@/shared/messages';
import {
  CaptureRequest,
  ContentToSw,
  DesignReadResult,
  PageMetricsResult,
  PanelToSw,
  ToolResult,
} from '@/shared/messages';
import { PORT_NAME } from '@/shared/port';
import { relayToPanel } from '@/shared/relay';
import { initSentry } from '@/shared/sentry';

// The preset the legacy OpenRouter-only RPCs (save-openrouter-key/set-model) map onto.
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// Content-routed tool transport: the slice-05 read/mutate `DomTool`s, the slice-13 page-driving +
// slice-15 complex-site `ControlTool`s, and the slice-14 describe-family `DescribeCmd`s
// (`describe`'s text modes, `extractIdentity`, `readImageContent`) all ride the same bus
// round-trip to the target frame's content script, so one dispatch serves all of them (assignable
// to `DomDispatch`, `ControlDispatch`/`ReadImagesDispatch`/`ComplexSiteDispatch`,
// `IdentityDispatch`, and `DescribeDispatch`/`ReadImageContentDispatch`).
type ContentDispatch = (
  msg: DomTool | ControlTool | DescribeCmd,
  signal?: AbortSignal,
) => Promise<ToolResult>;

// Let the page paint after a programmatic scroll before grabbing the viewport for a full-page stitch.
const SCROLL_SETTLE_MS = 200;

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

  // Per-tab design sessions: in-flight turn thread + accumulated changeset, mirrored to
  // chrome.storage.session so an SW eviction mid-turn resumes with context (src/agent/session).
  const sessions = new SessionStore();

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

  // Readiness (slice 03): pushed unsolicited whenever provider/model/host-permission/MCP
  // health changes, so the header pill updates without the panel polling the RPC.
  async function pushReadiness(): Promise<void> {
    postToPanel({ type: 'readiness', state: await computeReadiness(mcpManager) });
  }

  // Start/Stop session lifecycle (04 wires the real agent-turn AbortController into
  // `turnAbort`; this slice only tracks/pushes the tri-state and aborts if one is set).
  let sessionState: 'idle' | 'running' | 'stopped' = 'idle';
  let turnAbort: AbortController | null = null;

  function setSessionState(next: typeof sessionState): void {
    sessionState = next;
    postToPanel({ type: 'session-state', state: sessionState });
  }

  // Rehydrate the registry from the persisted server list before any RPC is served.
  // Registration is cheap/lazy (client.ts doesn't open until `tools()`/`connect()`).
  const mcpReady = listServers().then((stored) => {
    for (const s of stored) mcpManager.register(mcpSpec(s));
  });

  // Rehydrate persisted design sessions before any user-message turn reads them (SW wake).
  const sessionsReady = sessions.hydrate();

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

  // The page the user is designing = the active tab of the last-focused normal window. The
  // side panel isn't a tab, so a panel RPC's `sender.tab` is undefined — resolve the target here.
  async function resolveTargetTab(): Promise<chrome.tabs.Tab | undefined> {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab;
  }

  // Turn-scoped content-tool transport: reassembled DomTool/ControlTool → the target frame's content
  // script → typed ToolResult. Frame-aware (slice 13): `Target.frameId` routes via the sendMessage
  // `{ frameId }` option (default 0 = top document), and `Target.tabId` re-addresses another tab
  // (copy = user tab + reference tab). A child frame can't learn its own id, so the SW stamps the
  // frame it routed to onto a result that left it off. The content script is the only DOM world; a
  // send failure degrades to an error ToolResult the model reacts to rather than throwing the turn.
  function contentDispatchFor(defaultTabId: number): ContentDispatch {
    return async (message, signal) => {
      if (signal?.aborted) return { type: 'tool-result', ok: false, error: 'aborted' };
      const tabId = message.tabId ?? defaultTabId;
      const frameId = message.frameId ?? 0;
      try {
        const raw = await chrome.tabs.sendMessage(tabId, message, { frameId });
        const parsed = ToolResult.safeParse(raw);
        if (!parsed.success) {
          return { type: 'tool-result', ok: false, error: 'Malformed tool result from the page' };
        }
        return parsed.data.frameId === undefined ? { ...parsed.data, frameId } : parsed.data;
      } catch (err) {
        return { type: 'tool-result', ok: false, error: String(err) };
      }
    };
  }

  // `screenshot` transport (slice 13). An element/viewport crop routes to content (it computes the
  // rect, the SW crops — the slice-05 path); a `fullPage` capture is SW-owned scroll-stitch of the
  // top document (captureVisibleTab grabs the whole tab viewport, so it ignores `frameId`).
  function screenshotDispatchFor(defaultTabId: number): ScreenshotDispatch {
    const content = contentDispatchFor(defaultTabId);
    return async (input, signal) => {
      if (signal?.aborted) return { type: 'tool-result', ok: false, error: 'aborted' };
      if (!input.fullPage || input.selector) {
        return content(
          {
            type: 'screenshot',
            selector: input.selector,
            tabId: input.tabId,
            frameId: input.frameId,
          },
          signal,
        );
      }
      const tabId = input.tabId ?? defaultTabId;
      try {
        const tab = await chrome.tabs.get(tabId);
        return {
          type: 'tool-result',
          ok: true,
          data: await captureFullPage(tabId, tab.windowId, signal),
        };
      } catch (err) {
        return { type: 'tool-result', ok: false, error: String(err) };
      }
    };
  }

  async function handle(msg: PanelToSw, _tabId?: number) {
    await migrated; // settings reads must see the migrated (named-secret) state
    await mcpReady; // mcp-* cases need the registry rehydrated from storage
    await sessionsReady; // user-message resumes any persisted session thread
    switch (msg.type) {
      case 'user-message': {
        // Autonomous multi-step turn in the SW: stream tokens + tool-call chips to the panel,
        // route DOM tools to the content script, persist the thread/changeset for resume (04).
        const tab = await resolveTargetTab();
        if (tab?.id === undefined || !tab.url) {
          postToPanel({ type: 'error', message: 'Open a web page to start designing.' });
          return { ok: true };
        }
        const cfg = await getProviderConfig();
        if (!cfg) {
          postToPanel({ type: 'error', message: 'Add a model provider in Settings to start.' });
          return { ok: true };
        }
        const tabId = tab.id;

        // Supersede any in-flight turn, then run this one under a fresh abort controller (Stop /
        // a newer instruction aborts it). Session-start/-stop share `turnAbort` (slice 03).
        turnAbort?.abort();
        const controller = new AbortController();
        turnAbort = controller;

        await sessions.ensure(tabId, tab.url, crypto.randomUUID());
        const session = await sessions.appendMessages(tabId, { role: 'user', content: msg.text });

        // Copy/debug mode (slice 06): an explicit choice wins, else infer from the instruction —
        // sharpens the base system prompt's `modes` section into a concrete directive for this turn.
        const mode = resolveMode(msg.mode, msg.text);

        // Browser-control + vision dispatches (slice 13) — the loop builds the tools from these
        // (`interact`/`tabsFrames`/`vision`) and wraps `waitFor`/`navigate*`/`inspectVisually`
        // with its budget guards, so construction lives in one place (`loop.ts` `buildTools`)
        // and stays consistent with the DOM/browse tools instead of being assembled ad hoc here.
        // `content` drives the page (DOM + interaction) in the target frame; nav/tabs/frames run
        // SW-side against `chromeBrowserDriver`; vision captures + inspects.
        const model = createProvider(cfg);
        const content = contentDispatchFor(tabId);
        const screenshot = screenshotDispatchFor(tabId);

        // Fire-and-forget: the turn streams over the port for its lifetime, so the RPC acks now
        // (unblocking the panel). Completion persists spend + threads the assistant reply.
        void runTurn({
          tabId,
          messages: session.messages,
          signal: controller.signal,
          model,
          instructions: buildSystemPrompt({ addenda: modeGuidance(mode).addenda }),
          dispatch: content,
          browse: (input, signal) => runBrowse(chromeBrowseDriver, input, signal),
          interact: {
            control: content,
            nav: (msg, signal) => runNav(chromeBrowserDriver, msg, tabId, signal),
          },
          tabsFrames: {
            tabs: (msg) => runTabs(chromeBrowserDriver, msg),
            frames: (msg) => runFrames(chromeBrowserDriver, msg, tabId),
          },
          vision: {
            screenshot,
            readImages: content,
            inspect: (msg, signal) =>
              runInspect(
                {
                  model,
                  generate: visionGenerate,
                  capture: (i, sig) =>
                    screenshot(
                      {
                        type: 'screenshot',
                        selector: i.selector,
                        fullPage: i.fullPage,
                        tabId: i.tabId,
                        frameId: i.frameId,
                      },
                      sig,
                    ),
                },
                msg,
                signal,
              ),
          },
          // `extractIdentity` + `describe`'s text modes/`readImageContent` are cheap content
          // round-trips (the same `content` transport as the DOM tools); `describe`'s `scene` mode
          // is the one that costs a vision call, so it's the SW-orchestrated capture+generate path
          // (mirrors `vision.inspect` above, reusing `runDescribeScene`).
          identity: content,
          describe: {
            describe: content,
            scene: (msg, signal) =>
              runDescribeScene(
                { model, generate: visionGenerate, capture: screenshot },
                msg,
                signal,
              ),
            readImageContent: content,
          },
          // pageFacts/readChart/chartTooltip/widgetAct (slice 15) are content-routed exactly like
          // interact.control — same `content` transport, no extra SW-side logic needed.
          complexSite: content,
          emit: postToPanel,
          // Backend (MCP) tools win a name clash over the built-ins, per the loop's merge order.
          tools: await mcpManager.toolsFor(),
          approveHandoff: () => false, // never auto-ship; real Ship approval lands in slice 07
        })
          .then(async (outcome) => {
            // Only the still-current turn threads its result. A turn that was superseded (a
            // newer user-message) or Stopped already had `turnAbort` reassigned/cleared; its
            // partial reply streamed to the panel (the scrollback source of truth), but
            // appending it here would land *after* the newer user message and corrupt the
            // resume thread — so a non-current turn persists nothing.
            if (turnAbort !== controller) return;
            if (outcome.text) {
              await sessions.appendMessages(tabId, { role: 'assistant', content: outcome.text });
            }
            await sessions.patch(tabId, { usage: outcome.usage });
          })
          .catch((err) => postToPanel({ type: 'error', message: String(err) }))
          .finally(() => {
            if (turnAbort === controller) turnAbort = null;
          });

        return { ok: true };
      }
      case 'ship':
        // TODO: assemble changeset -> open MCP client (src/mcp) -> task(create).
        return { ok: true };

      // User-driven element picker: forward the panel's start/stop to the target tab's content
      // script as a PickerCmd (the overlay lives in the DOM world). Distinct from the agent's
      // DomTool calls — the picker is never agent-run. A missing/uninjectable tab is a no-op.
      case 'start-picker':
      case 'stop-picker': {
        const tab = await resolveTargetTab();
        if (tab?.id !== undefined) {
          const cmd: PickerCmd = {
            type: msg.type === 'start-picker' ? 'picker-start' : 'picker-stop',
          };
          await chrome.tabs.sendMessage(tab.id, cmd).catch(() => {});
        }
        return { ok: true };
      }

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
        void pushReadiness();
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
        if (valid) void pushReadiness();
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
        void pushReadiness();
        return { ok: true };
      }
      case 'key-status': {
        const cfg = await getProviderConfig();
        return { ok: true, present: await hasProviderKey(), model: cfg?.model };
      }
      case 'clear-openrouter-key':
        await clearProviderConfig();
        void pushReadiness();
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
        void pushReadiness();
        return { ok: true, server: toBusServer(stored) };
      }
      // Tear down the connection and purge the persisted record + both credential slots
      // (mcp/store.ts removeServer already clears the key-store side).
      case 'mcp-remove': {
        await mcpManager.unregister(msg.id);
        oauthConfigs.delete(msg.id);
        await removeServer(msg.id);
        void pushReadiness();
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
        void pushReadiness();
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
        void pushReadiness();
        return { ok: true, server: toBusServer(next) };
      }
      // Manual refresh: republish every registered server's current health on the
      // mcp-status stream (e.g. a panel that just (re)connected with no cached state).
      case 'mcp-status': {
        for (const stored of await listServers()) pushMcpStatus(stored);
        return { ok: true };
      }

      // --- readiness + session (slice 03) ---------------------------------
      case 'readiness':
        return { ok: true, state: await computeReadiness(mcpManager) };
      // Marks the session active (primes the agent — see 04) and flips the panel from
      // the readiness/empty state to chat. A stale in-flight turn from a prior session
      // is aborted first so it can never leak tokens into the new one.
      case 'session-start':
        turnAbort?.abort();
        turnAbort = null;
        setSessionState('running');
        return { ok: true };
      // Aborts the in-flight agent turn (04 sets `turnAbort` at turn-start) without
      // ending the session — the panel stays on chat, ready for the next message.
      case 'session-stop':
        turnAbort?.abort();
        turnAbort = null;
        setSessionState('stopped');
        return { ok: true };
    }
  }

  // Content -> SW push (fire-and-forget forwarding to the panel; no response).
  chrome.runtime.onMessage.addListener((raw) => {
    const parsed = ContentToSw.safeParse(raw);
    if (!parsed.success) return; // PanelToSw RPC handled by the listener above

    // Pure mapping lives in src/shared/relay.ts (testable; entrypoints are
    // coverage-excluded). null = the event carries nothing to forward.
    const out = relayToPanel(parsed.data);
    if (out) postToPanel(out);
  });

  // Screenshot capture (content -> SW, request/response). Only the SW has `tabs` capture; the
  // content script computes the crop rect and asks here. Capture the visible tab, crop to the
  // rect, and reply with a base64 PNG data URL. Any failure degrades to an error CaptureResult
  // the content script surfaces as an error ToolResult (the agent can retry / fall back to a11y).
  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const parsed = CaptureRequest.safeParse(raw);
    if (!parsed.success) return; // not a capture request
    captureVisibleTab(parsed.data, sender.tab?.windowId)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl } satisfies CaptureResult))
      .catch((err) => sendResponse({ ok: false, error: String(err) } satisfies CaptureResult));
    return true; // async response
  });
});

// Capture the visible tab as PNG, then crop to the requested (page-CSS-px) rect. `windowId` comes
// from the requesting content script's tab; falls back to the current window.
async function captureVisibleTab(req: CaptureRequest, windowId?: number): Promise<string> {
  const full = await chrome.tabs.captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
    format: 'png',
  });
  return cropDataUrl(full, req.rect, req.devicePixelRatio);
}

// Crop a PNG data URL to `rect` (scaled from CSS px to device px by `dpr`) via OffscreenCanvas —
// the SW's only imaging surface. The pure box math is `src/dom/read.ts` `cropBox` (tested);
// `null` (empty or whole-frame crop) and any decode/draw failure return the full frame unchanged,
// which still serves the agent's vision.
async function cropDataUrl(dataUrl: string, rect: Rect, dpr: number): Promise<string> {
  try {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const box = cropBox(rect, dpr, bitmap.width, bitmap.height);
    if (!box) return dataUrl;
    const canvas = new OffscreenCanvas(box.sw, box.sh);
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(bitmap, box.sx, box.sy, box.sw, box.sh, 0, 0, box.sw, box.sh);
    return await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
  } catch {
    return dataUrl;
  }
}

// --- browser control: navigation / tabs / frames (slice 13) --------------
// Chrome implementation of the SW-orchestration primitives. The tested decision logic lives in
// `src/agent/browser-control.ts`; this is only the chrome glue (coverage-excluded, like the browse
// driver). `waitForLoad` reuses the browse tab-load wait. Frame enumeration needs the `webNavigation`
// permission (added to the manifest in a later slice-13 task) — without it the call rejects and
// surfaces as an error ToolResult the agent reads.
const chromeBrowserDriver: BrowserControlDriver = {
  navigate: async (tabId, url) => {
    await chrome.tabs.update(tabId, { url });
  },
  goBack: (tabId) => chrome.tabs.goBack(tabId),
  reload: (tabId) => chrome.tabs.reload(tabId),
  waitForLoad: (tabId, signal) => waitForTabComplete(tabId, signal),
  getTab: (tabId) => chrome.tabs.get(tabId),
  listTabs: () => chrome.tabs.query({}),
  openTab: (url) => chrome.tabs.create({ url, active: true }),
  activateTab: async (tabId) =>
    (await chrome.tabs.update(tabId, { active: true })) ?? { id: tabId },
  closeTab: (tabId) => chrome.tabs.remove(tabId),
  listFrames: async (tabId) => {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return (frames ?? []).map((f) => ({
      frameId: f.frameId,
      url: f.url,
      parentFrameId: f.parentFrameId,
    }));
  },
};

// Adapt the AI SDK's `generateText` to the vision module's minimal injected shape (text out only),
// so `runInspect` stays SDK-decoupled + testable and this SW glue owns the real call.
const visionGenerate: GenerateVision = (args) => generateText(args).then((r) => ({ text: r.text }));

// --- full-page screenshot (scroll-stitch) --------------------------------
// Plan the scroll bands from the page's metrics (pure math in `planStitch`), grab the viewport at
// each band (captureVisibleTab is SW-only), and stitch them into one PNG. The user's scroll is
// restored even if a grab fails midway. captureVisibleTab is rate-limited without a broad host
// grant, so a very tall page can exceed the quota — that degrades to an error the agent can retry
// or fall back from (viewport shot / a11y).
async function captureFullPage(
  tabId: number,
  windowId: number | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const metrics = await requestPageMetrics(tabId);
  const plan = planStitch(metrics);
  if (plan.bands.length === 0) throw new Error('The page has no visible area to capture.');
  const frames: string[] = [];
  try {
    for (const band of plan.bands) {
      if (signal?.aborted) throw new Error('aborted');
      await sendScrollTo(tabId, band.scrollY);
      await browseDelay(SCROLL_SETTLE_MS, signal);
      frames.push(
        await chrome.tabs.captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
          format: 'png',
        }),
      );
    }
  } finally {
    // Best-effort restore — never let a failed grab strand the user scrolled to the page bottom.
    await sendScrollTo(tabId, metrics.scrollY).catch(() => {});
  }
  return stitchFrames(plan, frames);
}

// Ask the top document for its scroll + viewport geometry (SW -> content), the input to the stitch.
async function requestPageMetrics(tabId: number, frameId = 0): Promise<PageMetrics> {
  const request: PageMetricsRequest = { type: 'page-metrics' };
  const parsed = PageMetricsResult.safeParse(
    await chrome.tabs.sendMessage(tabId, request, { frameId }),
  );
  if (!parsed.success) throw new Error('Malformed page metrics from the page.');
  if (!parsed.data.ok || !parsed.data.metrics) {
    throw new Error(parsed.data.error ?? 'The page did not report its metrics.');
  }
  return parsed.data.metrics;
}

// Scroll the target frame to an absolute page offset (reuses the content interaction engine).
async function sendScrollTo(tabId: number, y: number, frameId = 0): Promise<void> {
  const message: ControlTool = { type: 'scrollTo', y };
  await chrome.tabs.sendMessage(tabId, message, { frameId });
}

// Compose the band grabs onto one device-px canvas per the plan's src/dest rects, then encode a
// single PNG. OffscreenCanvas is the SW's only imaging surface (as in cropDataUrl).
async function stitchFrames(plan: StitchPlan, frames: string[]): Promise<string> {
  const canvas = new OffscreenCanvas(plan.canvasWidth, plan.canvasHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas context for stitching.');
  for (let i = 0; i < plan.bands.length; i++) {
    const band = plan.bands[i];
    const frame = frames[i];
    if (!band || !frame) continue;
    const bitmap = await createImageBitmap(await (await fetch(frame)).blob());
    const width = Math.min(bitmap.width, plan.canvasWidth);
    ctx.drawImage(bitmap, 0, band.srcY, width, band.height, 0, band.destY, width, band.height);
    bitmap.close();
  }
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

// Blob -> `data:` URL without FileReader (not reliably present in the SW). btoa over the raw bytes
// is safe here: the input is binary PNG, chunked so a large frame can't blow the call stack.
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

// --- cross-site browse (slice 06) ----------------------------------------
// `browse(url)`: open a reference site in an INACTIVE background tab, read its compact design
// identity via the tab's content script, and close it — never hijacking the tab the user is on.
// The decision logic (permission gate, always-close, abort handling) lives in
// `src/agent/browse-tab.ts` (unit-tested) and the pure design-read in `src/dom/design-read.ts`
// (jsdom-tested); this is only the chrome glue that implements the orchestration's primitives
// (coverage-excluded, like the screenshot capture).
const BROWSE_LOAD_TIMEOUT_MS = 15_000; // snapshot whatever rendered if the site hangs past this
const BROWSE_READY_RETRIES = 20; // wait for the declared content script to start listening
const BROWSE_READY_DELAY_MS = 150;

/** Chrome implementation of the browse orchestration's primitives (host grant + tab lifecycle).
 *  Injected into the loop as `RunTurnArgs.browse` via `runBrowse(chromeBrowseDriver, …)`. The
 *  per-origin host grant can't be prompted here (no user gesture in an agent turn), so a
 *  not-yet-granted origin surfaces as a denial the agent relays — the grant comes from the panel. */
const chromeBrowseDriver: BrowseTabDriver = {
  hostAccess: (url) => ensureHostAccess(url),
  open: async (url) => (await chrome.tabs.create({ url, active: false })).id,
  waitForLoad: (tabId, signal) => waitForTabComplete(tabId, signal),
  readDesign: (tabId, signal) => requestDesignRead(tabId, signal),
  close: (tabId) => chrome.tabs.remove(tabId),
};

// Resolve when the background tab finishes loading, or when the load times out (we still snapshot
// whatever rendered). Rejects if the tab is closed underneath us or the turn aborts.
function waitForTabComplete(tabId: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, BROWSE_LOAD_TIMEOUT_MS);
    const onUpdated = (id: number, info: { status?: string }): void => {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    const onRemoved = (id: number): void => {
      if (id === tabId) {
        cleanup();
        reject(new Error('The browse tab was closed before it loaded.'));
      }
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error('aborted'));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Fast path: the tab may already be 'complete' by the time the listeners attached.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') {
          cleanup();
          resolve();
        }
      })
      .catch(() => {});
  });
}

// Poll the background tab's content script for its design read. The declared content script
// injects at document_idle once the origin permission is held; until it's listening, sendMessage
// rejects ("Receiving end does not exist"), so retry briefly. Once it answers, the result is
// terminal — a content-side failure isn't retried.
async function requestDesignRead(tabId: number, signal?: AbortSignal): Promise<DesignRead> {
  const request: DesignReadRequest = { type: 'design-read' };
  let lastError = 'the page did not respond';
  for (let attempt = 0; attempt < BROWSE_READY_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('aborted');
    let raw: unknown;
    try {
      raw = await chrome.tabs.sendMessage(tabId, request);
    } catch (err) {
      lastError = String(err); // content script not listening yet → retry after a short delay
      await browseDelay(BROWSE_READY_DELAY_MS, signal);
      continue;
    }
    const parsed = DesignReadResult.safeParse(raw);
    if (parsed.success && parsed.data.ok && parsed.data.read) return parsed.data.read;
    throw new Error(
      parsed.success
        ? (parsed.data.error ?? 'the page could not produce a design read')
        : 'malformed design read from the page',
    );
  }
  throw new Error(lastError);
}

// setTimeout as an abortable promise (the SW's only timer): resolves after `ms`, or rejects early
// if the turn aborts so the retry loop stops promptly.
function browseDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
