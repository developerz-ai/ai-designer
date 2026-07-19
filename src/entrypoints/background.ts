import { generateObject, generateText, type Tool } from 'ai';
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
import {
  type DeviceEmulationDriver,
  restoreDevice,
  runResponsiveCapture,
  runSetDevice,
} from '@/agent/device-emulation';
import {
  EmulationRegistry,
  type EmulationTeardown,
  type SavedWindow,
} from '@/agent/emulation-registry';
import { HistoryStore } from '@/agent/history-store';
import { getOpenRouterKey, setOpenRouterKey } from '@/agent/key-store';
import { runTurn } from '@/agent/loop';
import { modeGuidance, resolveMode } from '@/agent/modes';
import { createProvider, listModels, validateProvider } from '@/agent/provider';
import { computeReadiness } from '@/agent/readiness';
import { generateReport as authorReport, type GenerateReport } from '@/agent/report';
import { SessionStore } from '@/agent/session';
import { buildSystemPrompt } from '@/agent/system-prompt';
import { createSessionTools } from '@/agent/tools/session';
import type { ScreenshotDispatch } from '@/agent/tools/vision';
import { type GenerateVision, runDescribeScene, runInspect } from '@/agent/vision';
import { toMarkdown } from '@/changeset/report-md';
import { ChangesetStore, createSessionChangesetPersister } from '@/changeset/store';
import { cropBox, planStitch, type StitchPlan } from '@/dom/read';
import { headerResolverFor, saveApiKey, startOAuth } from '@/mcp/auth';
import {
  createTaskBackend,
  fallbackMessage,
  routeHandoff,
  type TaskToolExecute,
  taskBackends,
} from '@/mcp/backend';
import type { McpConnectionSpec } from '@/mcp/client';
import { originOf, planTasks, type ShipSource, ship } from '@/mcp/handoff';
import { McpManager } from '@/mcp/manager';
import {
  getOAuthConfigs,
  getOriginRepoMap,
  getServer,
  listServers,
  removeServer,
  type StoredServer,
  saveOAuthConfig,
  saveServer,
} from '@/mcp/store';
import { ensureHostAccess } from '@/shared/host-permissions';
import type {
  CaptureResult,
  CheckResponsiveInput,
  ControlTool,
  DescribeCmd,
  DesignRead,
  DesignReadRequest,
  DomTool,
  HandoffResult,
  McpOAuthConfig,
  McpServer,
  Mode,
  OverlayCmd,
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
  IdentityResult,
  PageMetricsResult,
  PanelToSw,
  ToolResult,
} from '@/shared/messages';
import { readOverlayEnabled, writeOverlayEnabled } from '@/shared/overlay-prefs';
import { overlayLabel } from '@/shared/overlay-step';
import { PORT_NAME } from '@/shared/port';
import { relayToPanel } from '@/shared/relay';
import type { Report } from '@/shared/report';
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
  msg: DomTool | ControlTool | DescribeCmd | CheckResponsiveInput,
  signal?: AbortSignal,
) => Promise<ToolResult>;

// Let the page paint after a programmatic scroll before grabbing the viewport for a full-page stitch.
const SCROLL_SETTLE_MS = 200;
// A device-emulation change re-evaluates media queries + reflows the whole layout — give it a beat
// longer than a scroll before capturing a responsive breakpoint.
const EMULATION_SETTLE_MS = 300;

// Device-emulation teardown state, persisted to chrome.storage.session so an SW eviction
// mid-emulation can be reconciled on wake (slice 16 / SW-resilience). `chromeDeviceDriver` records
// attach/resize here; `activeEmulationOwner` is the id of the turn currently applying emulation, so
// a superseded turn's teardown can be scoped to its own emulation (see the user-message `.finally`).
const emulation = new EmulationRegistry();
let activeEmulationOwner = '';

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

  // Last-10-conversations history (slice 08): a durable record of completed turns + their
  // shipped report/PR, mirrored to chrome.storage.local. Distinct from `sessions` above (the
  // in-flight, chrome.storage.session-backed resume state) — a conversation is appended here once
  // a turn finishes, and outlives the tab/session that produced it.
  const historyStore = new HistoryStore();

  // MCP registry (slice 02). OAuth endpoint configs (endpoints + public client id — NON-secret)
  // are persisted via mcp/store.ts and rehydrated into this in-memory Map in `mcpReady`, so a
  // refresh after SW eviction can still re-derive headers + refresh a stored token rather than
  // forcing the user to re-authorize. The token itself stays in the encrypted key-store.
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

  // Rehydrate the registry from the persisted server list before any RPC is served — after
  // rehydrating the persisted OAuth endpoint configs, so `mcpSpec`'s header resolver captures the
  // refresh config (otherwise a woken SW builds `oauth: undefined` and skips token refresh).
  // Registration is cheap/lazy (client.ts doesn't open until `tools()`/`connect()`). `.catch`
  // degrades to an empty registry rather than memoizing a rejection that would brick every future
  // RPC awaiting `mcpReady` (the awaited startup promises must never reject — see `handle`).
  const mcpReady = Promise.all([listServers(), getOAuthConfigs()])
    .then(([stored, oauth]) => {
      for (const [id, cfg] of Object.entries(oauth)) oauthConfigs.set(id, cfg);
      for (const s of stored) mcpManager.register(mcpSpec(s));
    })
    .catch(() => {});

  // Rehydrate persisted design sessions before any user-message turn reads them (SW wake).
  // `.catch` degrades to an empty cache rather than bricking every RPC that awaits it.
  const sessionsReady = sessions.hydrate().catch(() => {});

  // Rehydrate persisted history before any history-* RPC or turn-done append reads it (SW wake).
  const historyReady = historyStore.hydrate().catch(() => {});

  // Device-emulation teardown state (slice 16): rehydrate + reconcile any emulation orphaned by a
  // prior SW eviction (detach the debugger / restore the window) so the user isn't left mid-emulation.
  const emulationReady = emulation
    .hydrate()
    .then(() => emulation.reconcile(emulationTeardown))
    .catch(() => {});

  // On-page agent-decision overlay opt-in (slice 09): a plain persisted boolean
  // (src/shared/overlay-prefs.ts), mirrored in memory so a turn's tool-call stream can check it
  // synchronously per-event without an async storage read on every tool call.
  let overlayEnabled = false;
  const overlayReady = readOverlayEnabled()
    .then((v) => {
      overlayEnabled = v;
    })
    .catch(() => {});

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

  // User-triggered Ship / report handoff (slice 07) — NEVER auto-invoked (docs/idea/principles.md);
  // only the `ship` / `send-report` / `download-report` RPCs below reach it. Assemble the session's
  // changeset, then route (`src/mcp/backend.ts` `routeHandoff`): a connected backend exposing a `task`
  // tool + a repo mapped to this page's origin ⇒ dispatch `task(create)` (single, or one per problem)
  // and stream `task-status`; otherwise author the brief and return its Markdown for the panel to
  // download. The create+watch fan-out runs fire-and-forget so a long CI watch never blocks the RPC;
  // a planning error (empty changeset) surfaces synchronously in the reply.
  async function runHandoffRoute(opts: {
    source: 'changeset' | 'report';
    target?: string;
    mode?: Mode;
    problems?: readonly string[];
    title?: string;
    downloadOnly?: boolean;
  }): Promise<HandoffResult> {
    const tab = await resolveTargetTab();
    if (tab?.id === undefined || !tab.url) {
      return { ok: false, error: 'Open a web page to design first.' };
    }
    const cfg = await getProviderConfig();
    if (!cfg) return { ok: false, error: 'Add a model provider in Settings first.' };

    // Reuse (or ensure) this tab's design session so the changeset carries the SAME sessionId a
    // turn's `appendTurn` keyed history under — minting a fresh random id here would target a
    // history entry that never existed (`setReport` throws, swallowed → the brief goes unrecorded)
    // and break handoff idempotency. A session-less tab (report before any turn) still gets a
    // stable id via `ensure`.
    const session = await sessions.ensure(tab.id, tab.url, crypto.randomUUID());
    const changeset = session.changeset;
    // Ground the brief's token tables in the page's real palette/type/spacing (not the model's
    // guess) — best-effort: a page the content script can't reach (e.g. a chrome:// tab) just
    // ships without a tokens section rather than failing the whole handoff.
    const identity = await reportIdentity(contentDispatchFor(tab.id));

    const model = createProvider(cfg);
    const makeReport = (): Promise<Report> =>
      authorReport({ model, generate: reportGenerate }, { changeset, identity, mode: opts.mode });

    // "Download report" / "make a report" never dispatches — author the brief and return its Markdown.
    if (opts.downloadOnly) {
      const report = await makeReport();
      const markdown = toMarkdown(report);
      // Update-on-report (slice 08): attach the brief to this session's history entry, if it has
      // one — best-effort (`setReport` throws for an id `appendTurn` never created, e.g. a report
      // requested before any turn ran; that's not this RPC's failure to surface).
      await historyStore.setReport(changeset.sessionId, markdown).catch(() => {});
      return {
        ok: true,
        routed: 'report',
        markdown,
        filename: reportFilename(changeset.url),
      };
    }

    // Route decision — no model call. Needs the merged ToolSet (which connected backends expose a
    // `task` tool), the server list (id/label for `target` matching), and the origin→repo map.
    const [toolset, servers, originRepoMap] = await Promise.all([
      // toolsForShip: the ship route is the ONE sanctioned consumer of backend write tools —
      // it must see `<id>__task` to dispatch (design turns get the filtered default, #117).
      mcpManager.toolsForShip(),
      listServers(),
      getOriginRepoMap(),
    ]);
    const candidates = taskBackends(servers, Object.keys(toolset));
    const route = routeHandoff({
      url: changeset.url,
      originRepoMap,
      candidates,
      target: opts.target,
    });

    // No connected backend / no repo mapped ⇒ fall back to a downloadable brief (with the reason).
    if (route.kind === 'report') {
      if (opts.source === 'changeset' && changeset.edits.length === 0) {
        return { ok: false, error: 'Nothing to ship yet — make some edits first.' };
      }
      const report = await makeReport();
      const markdown = toMarkdown(report);
      await historyStore.setReport(changeset.sessionId, markdown).catch(() => {});
      return {
        ok: true,
        routed: 'report',
        markdown,
        filename: reportFilename(changeset.url),
        reason: fallbackMessage(route.reason),
      };
    }

    // Tasks route: build the source (authoring the brief for a report ship), validate the plan up
    // front so an empty changeset surfaces in the RPC, then dispatch create+watch fire-and-forget.
    const source: ShipSource =
      opts.source === 'changeset'
        ? { kind: 'changeset', changeset, title: opts.title }
        : {
            kind: 'report',
            report: applyProblems(await makeReport(), opts.problems),
            changeset,
            multiTask: (opts.problems?.length ?? 0) > 0,
            title: opts.title,
          };
    const target = { repo: route.repo, backend: route.backend.id };

    let taskCount: number;
    try {
      taskCount = planTasks(source, target).length;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const backend = createTaskBackend(
      taskExecutor(toolset[route.backend.taskToolName], route.backend.taskToolName),
    );
    void ship(source, target, {
      backend,
      onStatus: (update) => {
        postToPanel({ type: 'task-status', ...update });
        // Update-on-ship (slice 08): the PR a task opens lands as a `prUrl` on a later status
        // update — attach it to this session's history entry as soon as it's known. Best-effort,
        // same as the report path above.
        if (update.prUrl)
          void historyStore.setPrLink(changeset.sessionId, update.prUrl).catch(() => {});
      },
    }).catch((err) =>
      postToPanel({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
    );

    return { ok: true, routed: 'tasks', taskCount };
  }

  async function handle(msg: PanelToSw, _tabId?: number) {
    await migrated; // settings reads must see the migrated (named-secret) state
    await mcpReady; // mcp-* cases need the registry rehydrated from storage
    await sessionsReady; // user-message resumes any persisted session thread
    await historyReady; // history-* RPCs and turn-done append need the persisted ring buffer
    await overlayReady; // user-message/get-overlay-enabled need the hydrated in-memory flag
    await emulationReady; // any orphaned emulation is reconciled before a new turn emulates again
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

        // This turn's device-emulation owner: the driver stamps it on any attach/resize so a
        // superseded turn's teardown (below) only clears the emulation IT applied, never one a
        // newer concurrent same-tab turn has since taken over.
        const emulationOwner = crypto.randomUUID();
        activeEmulationOwner = emulationOwner;

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

        // On-page agent-decision overlay (slice 09): mirror every `tool-call` this turn streams to
        // the panel onto the target tab's overlay, when the user opted in. A send failure (the tab
        // navigated away / has no injected content script) is swallowed — the overlay is cosmetic,
        // never allowed to affect the turn.
        function forwardOverlayStep(update: SwToPanel): void {
          if (!overlayEnabled || update.type !== 'tool-call') return;
          const cmd: OverlayCmd = {
            type: 'overlay-step',
            label: overlayLabel(update.tool, update.selector),
            selector: update.selector,
            kind: update.kind,
          };
          void chrome.tabs.sendMessage(tabId, cmd).catch(() => {});
        }
        const emitTurn = (update: SwToPanel): void => {
          postToPanel(update);
          forwardOverlayStep(update);
        };

        // The session/recorder tools (slice 07): `recordEdit`/`undo`/`redo` mutate this tab's
        // changeset, `handoff` only proposes (gated below — never auto-ships). Rehydrate the
        // undo/redo-capable store from its own `chrome.storage.session` record (falling back to
        // the resume-context changeset `sessions.ensure` above just loaded/created), and mirror
        // every mutation to BOTH: the redo-capable record (`changesetPersister`, this store's own
        // durability) and `SessionStore` (`sessions.setChangeset`, so `runHandoffRoute`'s Ship/
        // report reads see the edit immediately, without waiting for the turn to finish).
        const changesetPersister = createSessionChangesetPersister(tabId);
        const priorChangesetState = await changesetPersister.load();
        const changesetStore = new ChangesetStore(
          priorChangesetState?.changeset ?? session.changeset,
          {
            redoStack: priorChangesetState?.redoStack,
          },
        );
        const sessionTools = createSessionTools({
          store: changesetStore,
          persist: async () => {
            await changesetPersister.save(changesetStore.snapshot());
            await sessions.setChangeset(tabId, changesetStore.current);
          },
          emit: postToPanel,
        });

        // Fire-and-forget: the turn streams over the port for its lifetime, so the RPC acks now
        // (unblocking the panel). Completion persists spend + threads the assistant reply.
        // Running cumulative session spend: seeded from the session's prior total, advanced in
        // `.then()`, and surfaced to the panel's usage meter on `turn-done` (#25).
        let sessionUsage = session.usage;
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
          // Device emulation + responsive capture (slice 16): `setDevice`/`responsiveCapture` are
          // SW-owned (chrome.debugger CDP + chrome.tabs capture) and run against `chromeDeviceDriver`;
          // `checkResponsive` is content-routed (the scanner runs in the page's world). The sweep
          // captures each breakpoint through the same `screenshot` dispatch the vision tools use, and
          // emulation is restored after the turn (see the `finally` below).
          responsive: {
            setDevice: (message) => runSetDevice(chromeDeviceDriver, message, tabId),
            capture: (message, signal) =>
              runResponsiveCapture(
                chromeDeviceDriver,
                (target, opts, sig) =>
                  screenshot(
                    {
                      type: 'screenshot',
                      selector: opts.selector,
                      fullPage: opts.fullPage,
                      tabId: target,
                    },
                    sig,
                  ),
                (sig) => browseDelay(EMULATION_SETTLE_MS, sig),
                message,
                tabId,
                signal,
              ),
            check: content,
          },
          emit: emitTurn,
          // Backend (MCP) + session/recorder tools win a name clash over the built-ins, per the
          // loop's merge order (a namespaced MCP tool can never collide with `recordEdit`/etc.).
          // The design turn only ever sees write-gated backend tools (#117): `toolsFor()` is
          // design-safe at the source (manager applies design-gate.ts), so the model cannot
          // dispatch `<id>__task` outside the user-clicked Ship RPC — which resolves its task
          // backends from the explicit `toolsForShip()` merge instead.
          tools: { ...(await mcpManager.toolsFor()), ...sessionTools },
          // Never auto-ship: the in-loop `handoff` tool stays denied — Ship is the user-triggered
          // `ship`/`send-report` RPC (`runHandoffRoute`), not something the agent invokes itself.
          approveHandoff: () => false,
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
            // Accumulate spend across the session's turns (nothing else reads `session.usage`, so
            // summing is safe) so the panel shows a running session total, not just the last turn.
            sessionUsage = {
              steps: sessionUsage.steps + outcome.usage.steps,
              tokens: sessionUsage.tokens + outcome.usage.tokens,
            };
            await sessions.patch(tabId, { usage: sessionUsage });
            // Persist this turn to history (slice 08): the conversation is keyed by the
            // changeset's sessionId (minted once per tab session), so every turn in the same
            // design session appends to one entry rather than forking a new ring-buffer slot.
            // Only this turn's new messages are appended — the full resume thread already lives
            // in `sessions`; history keeps its own size-bounded copy (see `history-store.ts`).
            const newMessages = outcome.text
              ? [
                  { role: 'user' as const, content: msg.text },
                  { role: 'assistant' as const, content: outcome.text },
                ]
              : [{ role: 'user' as const, content: msg.text }];
            await historyStore
              .appendTurn({
                id: changesetStore.current.sessionId,
                title: msg.text,
                url: changesetStore.current.url,
                mode,
                messages: newMessages,
              })
              .catch((err) => postToPanel({ type: 'error', message: String(err) }));
          })
          .catch((err) => postToPanel({ type: 'error', message: String(err) }))
          .finally(() => {
            // Same "still current" guard as the `.then()` above: a superseded turn (newer
            // user-message) or one Stop already cleared `turnAbort` and pushed `session-state:
            // 'stopped'` itself (case 'session-stop') — that already tells the chat store (11) the
            // turn is done, so this natural-completion signal only fires for the turn that's still
            // the one in flight.
            const wasCurrent = turnAbort === controller;
            if (wasCurrent) turnAbort = null;
            // Tear down device emulation ONLY if this turn still owns it (detach the debugger /
            // restore the window) so the user's page + the "being debugged" banner don't outlast the
            // turn — but never clear emulation a newer concurrent same-tab turn has taken over.
            if (emulation.owns(tabId, emulationOwner)) {
              void restoreDevice(chromeDeviceDriver, tabId).catch(() => {});
            }
            if (wasCurrent) postToPanel({ type: 'turn-done', usage: sessionUsage });
          });

        return { ok: true };
      }
      // Ship (user-triggered) — dispatch to a connected coding backend, else return an MD brief to
      // download. Never auto-ships; `runHandoffRoute` streams per-task status over the port.
      case 'ship':
        return runHandoffRoute({
          source: msg.source,
          target: msg.target,
          mode: msg.mode,
          problems: msg.problems,
          title: msg.title,
        });
      // "Download report" / chat "make a report": always the agent-authored MD brief, never a dispatch.
      case 'download-report':
        return runHandoffRoute({ source: 'report', mode: msg.mode, downloadOnly: true });
      // Chat "send this to <backend>": author + dispatch the brief to the named backend (falls back to
      // a downloadable brief when the target isn't connected or the origin has no repo mapped).
      case 'send-report':
        return runHandoffRoute({
          source: 'report',
          target: msg.target,
          mode: msg.mode,
          problems: msg.problems,
        });

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
        void pushReadiness().catch(() => {});
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
        if (valid) void pushReadiness().catch(() => {});
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
        void pushReadiness().catch(() => {});
        return { ok: true };
      }
      case 'key-status': {
        const cfg = await getProviderConfig();
        return { ok: true, present: await hasProviderKey(), model: cfg?.model };
      }
      case 'clear-openrouter-key':
        await clearProviderConfig();
        void pushReadiness().catch(() => {});
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
        void pushReadiness().catch(() => {});
        return { ok: true, server: toBusServer(stored) };
      }
      // Tear down the connection and purge the persisted record + both credential slots
      // (mcp/store.ts removeServer already clears the key-store side).
      case 'mcp-remove': {
        await mcpManager.unregister(msg.id);
        oauthConfigs.delete(msg.id);
        await removeServer(msg.id);
        void pushReadiness().catch(() => {});
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
        void pushReadiness().catch(() => {});
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
            // Persist the NON-secret endpoint config (never the token) so a woken SW can still
            // refresh the stored token instead of forcing re-auth (see mcpReady rehydration).
            await saveOAuthConfig(msg.id, msg.oauth);
            await startOAuth(msg.id, msg.oauth);
          }
        } catch (err) {
          return { ok: false, error: String(err) };
        }
        const next = await saveServer({ ...stored, authKind: msg.authKind });
        mcpManager.register(mcpSpec(next));
        await mcpManager.connect(msg.id);
        pushMcpStatus(next);
        void pushReadiness().catch(() => {});
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

      // --- history: last-10 conversations + reports (slice 08) ------------
      // Lightweight summaries for the History SPA list — never the full thread/report payload.
      case 'history-list':
        return { ok: true, conversations: historyStore.list() };
      // One conversation's full record for a read-only replay + re-download.
      case 'history-get': {
        const conversation = historyStore.get(msg.id);
        return conversation
          ? { ok: true, conversation }
          : { ok: false, error: `No conversation ${msg.id} in history` };
      }
      case 'history-delete':
        await historyStore.delete(msg.id);
        return { ok: true };

      // --- on-page agent-decision overlay opt-in (slice 09) ---------------
      // Persist + immediately push the new state to the active tab (content.ts also restores it
      // from storage on its own at document_idle, so a tab opened/reloaded after this still picks
      // it up without another round-trip here).
      case 'set-overlay-enabled': {
        overlayEnabled = msg.enabled;
        await writeOverlayEnabled(msg.enabled);
        const tab = await resolveTargetTab();
        if (tab?.id !== undefined) {
          const cmd: OverlayCmd = { type: 'overlay-toggle', enabled: overlayEnabled };
          await chrome.tabs.sendMessage(tab.id, cmd).catch(() => {});
        }
        return { ok: true, enabled: overlayEnabled };
      }
      case 'get-overlay-enabled':
        return { ok: true, enabled: overlayEnabled };
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

// --- device emulation (slice 16) -----------------------------------------
// Chrome glue for the emulation runners. The preferred path drives `chrome.debugger` + CDP for TRUE
// device emulation (DPR + touch + UA, so media queries / `@media (pointer)` / UA-sniffing all fire);
// the fallback resizes the tab's window to approximate a narrow viewport when the `debugger`
// permission is unavailable/denied. The tested decision logic (preset resolution, CDP-vs-fallback,
// sweep, restore) lives in `src/agent/device-emulation.ts`; this is only the chrome glue
// (coverage-excluded, like the browse/browser drivers). Emulation is torn down on turn end.
const CDP_VERSION = '1.3';
// Which tabs have the debugger attached + which windows we've resized is tracked in the persisted
// `emulation` registry (survives SW eviction) rather than a bare in-memory Set/Map, and keyed by the
// owning turn so attach stays idempotent, restore returns each window to its pre-emulation bounds,
// and a woken SW can reconcile emulation orphaned by an eviction (see `emulationReady`).

const chromeDeviceDriver: DeviceEmulationDriver = {
  // `chrome.debugger` exists only when the `debugger` permission is declared + granted; otherwise the
  // runner takes the viewport fallback. (Permission is added in the following slice-16 task.)
  cdpAvailable: () => typeof chrome.debugger !== 'undefined',
  applyCdp: async (tabId, device) => {
    if (!emulation.isAttached(tabId)) {
      await chrome.debugger.attach({ tabId }, CDP_VERSION);
      await emulation.recordAttach(tabId, activeEmulationOwner);
    }
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.dpr,
      mobile: device.mobile,
    });
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTouchEmulationEnabled', {
      enabled: device.touch,
      maxTouchPoints: device.touch ? 5 : 0,
    });
    // A resolved desktop device carries no UA — override with the browser's own so switching
    // mobile→desktop mid-sweep clears the prior mobile UA (an empty string wouldn't reset it).
    await chrome.debugger.sendCommand({ tabId }, 'Network.setUserAgentOverride', {
      userAgent: device.userAgent ?? navigator.userAgent,
    });
  },
  clearCdp: async (tabId) => {
    if (!emulation.isAttached(tabId)) return;
    await emulation.clearAttach(tabId);
    // Detaching drops every override in one call; best-effort (the tab may already be gone).
    await chrome.debugger.detach({ tabId }).catch(() => {});
  },
  applyViewport: async (tabId, device) => {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId === undefined) throw new Error('The tab has no window to resize.');
    if (!emulation.savedWindow(tabId)) {
      const win = await chrome.windows.get(tab.windowId);
      await emulation.recordWindow(tabId, activeEmulationOwner, {
        windowId: tab.windowId,
        width: win.width,
        height: win.height,
      });
    }
    await chrome.windows.update(tab.windowId, {
      state: 'normal',
      width: device.width,
      height: device.height,
    });
  },
  clearViewport: async (tabId) => {
    const saved = emulation.savedWindow(tabId);
    if (!saved) return;
    await emulation.clearWindow(tabId);
    await chrome.windows
      .update(saved.windowId, { width: saved.width, height: saved.height })
      .catch(() => {});
  },
};

// The raw debugger/window teardown the wake reconcile drives to undo emulation orphaned by an SW
// eviction — kept separate from the driver above (which also mutates the registry) so `reconcile`
// can restore persisted state without re-reading a registry it's about to clear.
const emulationTeardown: EmulationTeardown = {
  detach: (tabId) => chrome.debugger.detach({ tabId }),
  restoreWindow: (saved: SavedWindow) =>
    chrome.windows
      .update(saved.windowId, { width: saved.width, height: saved.height })
      .then(() => {}),
};

// Adapt the AI SDK's `generateText` to the vision module's minimal injected shape (text out only),
// so `runInspect` stays SDK-decoupled + testable and this SW glue owns the real call.
const visionGenerate: GenerateVision = (args) => generateText(args).then((r) => ({ text: r.text }));

// --- Ship / report handoff glue (slice 07) -------------------------------
// Adapt the AI SDK's `generateObject` to the report pass's minimal injected shape (`GenerateReport`),
// exactly as `visionGenerate` does for the vision module — the model call is SW-only, this glue owns it.
const reportGenerate: GenerateReport = (args) =>
  generateObject({
    model: args.model,
    schema: args.schema,
    system: args.system,
    messages: args.messages,
    abortSignal: args.abortSignal,
  }).then((result) => ({ object: result.object }));

// Re-extract the page's design identity for the handoff brief's tokens table, independent of
// whether the turn itself ever called `extractIdentity` (a Ship right after a plain edit turn
// should still speak in tokens). Reuses the same content round-trip the agent tool drives (`content`
// = `contentDispatchFor(tabId)`, in scope only inside `defineBackground`); any failure (unreachable
// tab, malformed reply) degrades to no tokens section rather than blocking Ship.
async function reportIdentity(content: ContentDispatch): Promise<IdentityResult | undefined> {
  const result = await content({ type: 'extractIdentity' }).catch(() => undefined);
  if (!result?.ok) return undefined;
  const parsed = IdentityResult.safeParse(result.data);
  return parsed.success ? parsed.data : undefined;
}

// A stable filename for a downloaded brief — per origin, no timestamp so a re-download overwrites
// predictably. Sanitized to filename-safe chars.
function reportFilename(url: string): string {
  const host = originOf(url)?.replace(/[^a-z0-9.-]/gi, '-');
  return `design-review-${host || 'page'}.md`;
}

// Override an authored report's problems with an explicit list (the panel/chat chooses which problems
// become tasks); an empty/absent list leaves the authored problems intact.
function applyProblems(report: Report, problems?: readonly string[]): Report {
  return problems && problems.length > 0 ? { ...report, problems: [...problems] } : report;
}

// Adapt a connected backend's namespaced `task` tool (from the merged MCP ToolSet) to the injected
// `TaskToolExecute` seam the Ship adapter drives. A tool with no `execute` (shouldn't happen for an
// MCP tool) fails that task rather than throwing the whole fan-out.
function taskExecutor(tool: Tool | undefined, name: string): TaskToolExecute {
  return async (args, signal) => {
    if (!tool?.execute) throw new Error(`MCP task tool "${name}" is not callable`);
    return tool.execute(args, {
      toolCallId: crypto.randomUUID(),
      messages: [],
      abortSignal: signal,
      context: undefined,
    });
  };
}

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
