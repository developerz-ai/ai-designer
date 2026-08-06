import { generateObject, generateText, type Tool } from 'ai';
import { defineBackground } from '#imports';
import { type BrowseTabDriver, runBrowse } from '@/agent/browse-tab';
import { type BrowserControlDriver, runFrames, runNav, runTabs } from '@/agent/browser-control';
import { withCaptureLock } from '@/agent/capture-lock';
import { shouldRideCaptureLock } from '@/agent/capture-policy';
import { type CaptureTargetProbe, captureBlockedReason } from '@/agent/capture-target';
import {
  clearProviderConfig,
  getProviderConfig,
  hasProviderKey,
  migrateLegacyProvider,
  saveProviderConfig,
} from '@/agent/config-store';
import {
  createDeviceDriver,
  DEBUGGER_PROTOCOL_VERSION,
  type DeviceChrome,
} from '@/agent/device-driver';
import { restoreDevice, runResponsiveCapture, runSetDevice } from '@/agent/device-emulation';
import {
  EmulationRegistry,
  type EmulationTeardown,
  type SavedWindow,
} from '@/agent/emulation-registry';
import { groundUserText } from '@/agent/focus-context';
import { HistoryStore } from '@/agent/history-store';
import { getOpenRouterKey, setOpenRouterKey } from '@/agent/key-store';
import { runTurn } from '@/agent/loop';
import { modeGuidance, resolveMode } from '@/agent/modes';
import { cachedSystemPrompt, withCacheBreakpoint } from '@/agent/prompt-cache';
import {
  createProvider,
  keyMissing,
  listModels,
  MISSING_KEY_ERROR,
  validateProvider,
} from '@/agent/provider';
import { computeReadiness } from '@/agent/readiness';
import { generateReport as authorReport, type GenerateReport } from '@/agent/report';
import { type ChatMessage, SessionStore } from '@/agent/session';
import {
  readSessionLifecycle,
  reconcileTurnStatus,
  writeSessionLifecycle,
} from '@/agent/session-lifecycle';
import { buildSystemPrompt } from '@/agent/system-prompt';
import { compactForThread } from '@/agent/thread-compact';
import { createSessionTools } from '@/agent/tools/session';
import type { ScreenshotDispatch } from '@/agent/tools/vision';
import { type GenerateVision, runDescribeScene, runInspect } from '@/agent/vision';
import { applyChangesetOp, type ChangesetOp, readChangeset } from '@/changeset/panel-ops';
import { createPendingMutations, foldMutationEvents } from '@/changeset/pending-mutations';
import { toMarkdown } from '@/changeset/report-md';
import { retractFromEdits } from '@/changeset/revert-match';
import { ChangesetStore, createSessionChangesetPersister } from '@/changeset/store';
import { cropBox, planStitch, type StitchPlan } from '@/dom/read';
import { headerResolverFor, saveApiKey, startOAuth } from '@/mcp/auth';
import {
  createTaskBackend,
  fallbackMessage,
  routeHandoff,
  TASK_TOOL,
  type TaskToolExecute,
  taskBackends,
} from '@/mcp/backend';
import type { McpConnectionSpec } from '@/mcp/client';
import { isWriteShaped, toolBaseName } from '@/mcp/design-gate';
import { originOf, planTasks, type ShipSource, ship } from '@/mcp/handoff';
import { McpManager } from '@/mcp/manager';
import {
  clearOriginRepo,
  getOAuthConfigs,
  getOriginRepoMap,
  getServer,
  listServers,
  removeServer,
  type StoredServer,
  saveOAuthConfig,
  saveServer,
  setOriginRepo,
} from '@/mcp/store';
import { clearToolGrants, getToolGrants, setToolGrant } from '@/mcp/tool-grants';
import { emptyChangeset } from '@/shared/changeset';
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
  MutationEvent,
  OverlayCmd,
  PageMetrics,
  PageMetricsRequest,
  PickerCmd,
  Rect,
  SessionLifecycle,
  SessionStateResult,
  SwToPanel,
  ThreadGetResult,
  ThreadViewMessage,
  UserMessageResult,
} from '@/shared/messages';
// Value import (a Zod schema, parsed at runtime) — the block below is `import type`.
import {
  CaptureRequest,
  ContentToSw,
  DesignReadResult,
  HISTORY_MAX_MESSAGES,
  IdentityResult,
  OverlayAck,
  PageMetricsResult,
  PanelToSw,
  ToolResult,
} from '@/shared/messages';
import { readOnboardingDismissed, writeOnboardingDismissed } from '@/shared/onboarding-prefs';
import { readOverlayEnabled, writeOverlayEnabled } from '@/shared/overlay-prefs';
import { overlayLabel } from '@/shared/overlay-step';
import { PORT_NAME } from '@/shared/port';
import { relayToPanel } from '@/shared/relay';
import type { Report } from '@/shared/report';
import { SCROLL_SETTLE_MS } from '@/shared/scroll';
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

// A device-emulation change re-evaluates media queries + reflows the whole layout — give it a beat
// longer than a scroll before capturing a responsive breakpoint.
const EMULATION_SETTLE_MS = 300;

// Ceiling on how long a superseding user-message waits for the aborted turn's finalization
// (thread + history persistence) before giving up and forfeiting it (#168). An aborted SDK
// stream settles in milliseconds; the bound only matters when a provider hangs on abort — the
// new turn must not be hostage to it.
const SUPERSEDE_SETTLE_MS = 3_000;

// The chrome.storage.session key mirroring a tab's last committed main-frame URL (stamped by the
// webNavigation.onCommitted listener on every main-frame commit) so the turn-start URL guard
// survives an SW eviction — the in-memory `lastCommittedUrl` map dies with the worker, this
// doesn't (#9 review round 4).
const committedUrlKey = (tabId: number): string => `committedUrl:${tabId}`;

// Read the persisted committed-URL stamp for the turn-start URL guard. Best-effort: a storage
// hiccup (or a never-stamped tab) yields `undefined` and the guard falls back to the in-memory
// map, then the live tab.url.
async function readCommittedUrl(tabId: number): Promise<string | undefined> {
  try {
    const got = await chrome.storage.session.get(committedUrlKey(tabId));
    const value = got[committedUrlKey(tabId)];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

// Device-emulation teardown state, persisted to chrome.storage.session so an SW eviction
// mid-emulation can be reconciled on wake (slice 16 / SW-resilience). Each TURN builds its own
// driver (`deviceDriverFor(owner)`), which stamps that turn's id on every attach/resize it records,
// so a superseded turn's teardown is scoped to its own emulation (see the user-message `.finally`).
// The owner used to be a module-level `let` read after an await inside the driver — see
// `src/agent/device-driver.ts` for the mis-stamping that caused (#165 S3).
const emulation = new EmulationRegistry();

// Service worker — the brain. Holds keys, runs the agent loop, owns MCP clients
// and the changeset store. NEVER expose the OpenRouter key to the content script
// (it shares the page's world). See docs/architecture/{components,security}.md.

export default defineBackground(() => {
  initSentry();

  // Repair the tabs an install/update just orphaned. Content scripts are injected at
  // `document_idle`, so every tab that was ALREADY OPEN when the extension is installed, updated,
  // or reloaded from chrome://extensions keeps running without one — and stays that way until the
  // user happens to reload it. Every DOM tool then fails with Chrome's
  // "Could not establish connection. Receiving end does not exist.", which reads as a broken
  // extension rather than "reload the page". Re-injecting closes that window without asking the
  // user to do anything.
  //
  // Driven off the manifest's own `content_scripts` rather than hardcoded paths, so adding or
  // renaming an entrypoint (or its `world`) can't silently desync this from what actually ships.
  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason !== 'install' && reason !== 'update') return;
    void reinjectAllTabs();
  });

  // …and again at every worker boot. `onInstalled` does NOT fire when an UNPACKED extension is
  // reloaded from chrome://extensions — which is exactly what a developer does after every build.
  // The old content script stays in every open tab with its `chrome.*` bridge invalidated: a
  // corpse that still holds capture-phase listeners, so the page looks alive and nothing works.
  // The worker always restarts on reload, so booting is the one reliable signal. Re-injection is
  // idempotent — content.ts's newest instance tears down the previous one (see its TAKEOVER note).
  void reinjectAllTabs();

  /** Re-run every declared content script in every already-open http(s) tab. Best-effort per tab
   *  AND per script: a tab we have no host access to, a chrome:// page, the Web Store, a
   *  discarded tab — all throw, and none of them should stop the rest. Re-injection is safe to
   *  repeat: a frame that already has the script simply gets a second evaluation of a module that
   *  guards its own listeners. */
  async function reinjectAllTabs(): Promise<void> {
    if (typeof chrome.scripting === 'undefined') return; // Firefox / older Chrome
    const scripts = chrome.runtime.getManifest().content_scripts ?? [];
    if (scripts.length === 0) return;
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []);
    await Promise.all(
      tabs.flatMap((tab) =>
        tab.id === undefined
          ? []
          : scripts.map((script) =>
              chrome.scripting
                .executeScript({
                  target: { tabId: tab.id as number, allFrames: script.all_frames ?? false },
                  files: script.js ?? [],
                  // `world` is load-bearing — the page-facts bridge MUST land in MAIN, not the
                  // isolated world — but chrome-types' ManifestV3 content_scripts entry predates
                  // the field, so it is read structurally rather than off the declared type.
                  world: (script as { world?: string }).world === 'MAIN' ? 'MAIN' : 'ISOLATED',
                })
                .catch(() => {}),
            ),
      ),
    );
  }

  // Clicking the toolbar action opens (and toggles closed) the side panel — the panel's primary
  // entry point. `openPanelOnActionClick` is a persisted setting, but re-asserting it on every SW
  // startup keeps it correct across a fresh install or a reset; there is deliberately NO
  // `chrome.action.onClicked` handler (registering one would suppress this native toggle). Guarded
  // on API presence (mirrors the `chrome.debugger` guard below): `chrome.sidePanel` is absent on
  // Firefox (`dev:firefox`) and Chrome <114, where the property access would throw SYNCHRONOUSLY —
  // before the `.catch` — and abort the rest of this service worker. On a runtime without the API
  // the panel is simply unavailable; the rest of the SW still boots.
  if (typeof chrome.sidePanel !== 'undefined') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }

  // Port a pre-ProviderConfig OpenRouter install into the named-secret scheme before any
  // settings RPC reads state. `handle` awaits this so a save/read can't race the migration.
  const migrated = migrateLegacyProvider().catch(() => {
    // Migration is best-effort: a failure just leaves the legacy key un-ported (the user can
    // re-enter it). Swallow so it never rejects an unrelated settings RPC.
  });

  // Per-tab design sessions: in-flight turn thread + accumulated changeset, mirrored to
  // chrome.storage.session so an SW eviction mid-turn resumes with context (src/agent/session).
  const sessions = new SessionStore();

  // #9 recorder buffer: content-side MutationEvents per tab. The user-message turn wires it into
  // `recordEdit` (ground-truth fold per selector group) and the turn-done path auto-finalizes
  // what's left; a main-frame navigation wipes the tab's buffer (nav-clear below).
  const pendingMutations = createPendingMutations();

  // Document-identity authority for the turn-start URL guard (#9 review round 2): the last
  // CROSS-DOCUMENT committed main-frame URL per tab, stamped by the webNavigation.onCommitted
  // listener below on EVERY main-frame commit (all transitionTypes, reload included — a reload
  // re-commits the same document). Hash changes and history.pushState/replaceState are
  // SAME-document: no onCommitted fires, the DOM + live edits survive, so they must never
  // stale the changeset record — comparing against the live tab.url (hash included) would
  // false-wipe it. Every stamp is ALSO mirrored to chrome.storage.session (`committedUrl:<tabId>`)
  // so the guard survives an SW eviction (#9 review round 4): a woken worker's map is empty, but
  // the persisted stamp still anchors the comparison — without it the guard fell back to the
  // live tab.url and a same-document hash change after an eviction wiped the record.
  const lastCommittedUrl = new Map<number, string>();

  // Last-10-conversations history (slice 08): a durable record of completed turns + their
  // shipped report/PR, mirrored to chrome.storage.local. Distinct from `sessions` above (the
  // in-flight, chrome.storage.session-backed resume state) — a conversation is appended here once
  // a turn finishes, and outlives the tab/session that produced it.
  const historyStore = new HistoryStore();

  // MCP registry (slice 02). OAuth endpoint configs (endpoints + public client id — NON-secret)
  // are persisted via mcp/store.ts and rehydrated into this in-memory Map in `mcpReady`, so a
  // refresh after SW eviction can still re-derive headers + refresh a stored token rather than
  // forcing the user to re-authorize. The token itself stays in the encrypted key-store.
  // grantsFor wires the #120 per-tool opt-in store into the design-turn gate: toolsFor filters
  // each server's write-shaped tools against the user's grants before merging.
  const mcpManager = new McpManager({
    grantsFor: async (serverId) => (await getToolGrants())[serverId] ?? [],
  });
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

  async function toBusServer(stored: StoredServer): Promise<McpServer> {
    const health = mcpManager.health(stored.id);
    // #120: the panel's per-tool toggles read the gate's view — the discovered tools that are
    // write-shaped (BASE names; `task` excluded — it can never be granted) + the granted subset.
    const granted = (await getToolGrants())[stored.id] ?? [];
    const writeTools = (health?.tools ?? [])
      .map((name) => toolBaseName(name))
      .filter((base) => base !== TASK_TOOL && isWriteShaped(base));
    return {
      id: stored.id,
      label: stored.label,
      url: stored.url,
      transport: stored.transport,
      authKind: stored.authKind,
      enabled: stored.enabled,
      status: health?.status ?? 'disconnected',
      toolCount: health?.toolCount ?? 0,
      tools: health?.tools ?? [],
      writeTools: [...new Set(writeTools)],
      grantedTools: granted.filter((g) => writeTools.includes(g)),
      error: health?.error,
    };
  }

  function pushMcpStatus(stored: StoredServer): void {
    // `toBusServer` awaits chrome.storage.local (the #120 grant map), which can reject; `mcp-status`
    // fans this out over EVERY configured server, so an uncaught rejection here is N unhandled
    // rejections Sentry reports as crashes for a storage hiccup that costs only a stale status row
    // (#165 S9). Every other `void`-ed promise in this file is caught; so is this one now.
    void toBusServer(stored)
      .then((server) => postToPanel({ type: 'mcp-status', server }))
      .catch((err) =>
        console.warn(`[mcp-status] failed to publish health for server ${stored.id}:`, err),
      );
  }

  // Readiness (slice 03): pushed unsolicited whenever provider/model/host-permission/MCP
  // health changes, so the header pill updates without the panel polling the RPC.
  async function pushReadiness(): Promise<void> {
    postToPanel({ type: 'readiness', state: await computeReadiness(mcpManager) });
  }

  // Start/Stop session lifecycle (04 wires the real agent-turn AbortController into
  // `turnAbort`; this slice only tracks/pushes the tri-state and aborts if one is set).
  // Mirrored to chrome.storage.session (#165 S5) so it survives an SW eviction — a woken worker
  // that reported `idle` here was the reason a panel could never learn a session was still open.
  let sessionState: SessionLifecycle = 'idle';
  let turnAbort: AbortController | null = null;
  // #168 turn attribution: the id of the turn `turnAbort` belongs to (stamped on every stream
  // event that turn emits), plus the ids of user-messages ACCEPTED but not yet launched — the
  // setup window (config reads, supersede settlement, changeset rehydration) used to report
  // `turnRunning: false` to a reconnecting panel for a turn that was about to start (#168 H4).
  let runningTurnId: string | null = null;
  const startingTurns = new Set<string>();
  const isTurnRunning = (): boolean => turnAbort !== null || startingTurns.size > 0;
  const liveTurnId = (): string | undefined => runningTurnId ?? [...startingTurns].at(-1);
  // The in-flight turn's finalization (thread/history persistence): a superseding user-message
  // AWAITS this (bounded) before appending its own user message, so the session thread stays
  // [user1, assistant1(partial), user2] — one source of truth for ordering. A turn that missed
  // the bound is FORFEITED: its late finalization must no longer append (it would land after
  // the newer user message and corrupt the resume thread).
  let settlingTurn: { id: string; done: Promise<void> } | null = null;
  const forfeitedTurns = new Set<string>();
  // The in-flight turn's changeset store + persist hook, registered at turn start and cleared in
  // the turn's `.finally` (and on session start/stop) — the mid-turn half of the recorder-revert
  // retraction (`retractRevertedEdit` below) strips the reverted event from THIS store too, so
  // the turn's next `persistChangeset` can't resurrect a phantom the page already reverted (#9
  // review round 4). Keyed by tab so a revert from another tab never touches it.
  let turnChangeset: {
    tabId: number;
    store: ChangesetStore;
    persist: () => Promise<void>;
  } | null = null;

  // Per-tab serialization of the durable-changeset mutation paths (#142 item 1): the curation
  // RPCs' load→mutate→save→mirror (the `changeset-*` cases) and the turn's rehydration (load →
  // store build → reseed persist → `turnChangeset` registration, the `user-message` case) append
  // to ONE promise chain per tab. The post-load `guard` re-check closed the turn-start-during-
  // load race, but a turn starting inside a curation op's save→mirror tail (single-digit ms)
  // still loaded the pre-op record and persisted over the curation; with the tail on the chain,
  // the turn's rehydration runs only after the op settles, so it seeds from the POST-op record.
  // FIFO per tab; a rejected op doesn't poison the chain (the stored link swallows it, the caller
  // still sees it — the capture-lock pattern); the link self-evicts on settle (compare-and-delete,
  // so a newer op queued behind it is never dropped). The recorder-revert retraction and the
  // nav-clear wipe deliberately stay OFF the chain: the former is best-effort by design (its
  // mid-turn half already strips the turn's own store), the latter carries its own race re-check.
  const changesetMutations = new Map<number, Promise<void>>();

  function enqueueChangesetMutation<T>(tabId: number, run: () => Promise<T>): Promise<T> {
    const prior = changesetMutations.get(tabId) ?? Promise.resolve();
    const result = prior.then(run, run);
    const link = result.then(
      () => {},
      () => {},
    );
    changesetMutations.set(tabId, link);
    void link.then(() => {
      if (changesetMutations.get(tabId) === link) changesetMutations.delete(tabId);
    });
    return result;
  }

  function setSessionState(next: SessionLifecycle): void {
    sessionState = next;
    // Persist before pushing so an eviction right after the push still wakes into the right state
    // (#165 S5). Fire-and-forget + self-catching: a failed write only degrades a later wake.
    void writeSessionLifecycle(next);
    postToPanel({ type: 'session-state', state: sessionState, turnRunning: isTurnRunning() });
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
      for (const s of stored) mcpManager.register(mcpSpec(s), { enabled: s.enabled });
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

  // The persisted session lifecycle, rehydrated before the first `session-state` push so a panel
  // connecting to a woken worker isn't told `idle` for a session that is still open (#165 S5).
  const lifecycleReady = readSessionLifecycle()
    .then((state) => {
      sessionState = state;
    })
    .catch(() => {});

  const panelPorts = new Set<chrome.runtime.Port>();
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    panelPorts.add(port);
    port.onDisconnect.addListener(() => {
      panelPorts.delete(port);
    });
    // Push the current state to the newly-connected panel (#165 S5). Without this a panel that
    // reconnected to a worker woken mid-turn waits forever: `turn-done`/`error`/`session-state`
    // all belong to a worker that no longer exists, so the in-flight assistant bubble never closes.
    // `turnRunning: false` on a woken worker is the signal that closes it.
    void lifecycleReady.then(() => {
      try {
        port.postMessage({
          type: 'session-state',
          state: sessionState,
          turnRunning: isTurnRunning(),
        } satisfies SwToPanel);
      } catch {
        // Disconnected between connect and this push — `postToPanel` prunes it on the next fan-out.
      }
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

  /**
   * Ceiling on ONE content round-trip. Every DOM/control tool rides the per-tab capture mutex
   * (`withCaptureLock`), so a single call that never settles does not just lose its own result —
   * it wedges that tab's chain forever and every later tool call in the session queues behind it.
   * The observed symptom is a turn that simply stops, with the last tool chip spinning.
   *
   * `chrome.tabs.sendMessage` has no timeout of its own: if the content listener returns `true`
   * (async) and then never calls `sendResponse` — a queued task awaiting something that never
   * happens, a frame torn down mid-flight — the promise stays pending for the life of the worker.
   * Generous enough for the slowest legitimate call (a full-page stitch's per-band settle, a
   * `waitFor`), short enough that a wedged tab recovers on its own.
   */
  const CONTENT_TIMEOUT_MS = 45_000;

  /** Reject `promise` if it has not settled within `ms`. The timer is always cleared, so a slow
   *  round-trip that DOES land never leaves a pending timer holding the worker awake. */
  function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`\`${what}\` did not answer within ${ms / 1000}s`)),
        ms,
      );
    });
    return Promise.race([promise, deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }) as Promise<T>;
  }

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
  // The raw content round-trip behind contentDispatchFor — extracted so a lock HOLDER (the
  // responsive sweep's internal element/viewport captures) can send without re-entering the lock
  // and self-deadlocking. Everything contentDispatchFor does except the lock itself.
  async function sendContentRaw(
    tabId: number,
    frameId: number,
    message: DomTool | ControlTool | DescribeCmd | CheckResponsiveInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    // Re-checked here (not just at dispatch entry): a locked screenshot may wait out a stitch
    // holder, and the turn may have aborted during the wait.
    if (signal?.aborted) return { type: 'tool-result', ok: false, error: 'aborted' };
    try {
      const raw = await withDeadline(
        chrome.tabs.sendMessage(tabId, message, { frameId }),
        CONTENT_TIMEOUT_MS,
        message.type,
      );
      const parsed = ToolResult.safeParse(raw);
      if (!parsed.success) {
        return { type: 'tool-result', ok: false, error: 'Malformed tool result from the page' };
      }
      return parsed.data.frameId === undefined ? { ...parsed.data, frameId } : parsed.data;
    } catch (err) {
      // "Could not establish connection. Receiving end does not exist." means there is no content
      // script in that tab — which is almost never a page problem: content scripts are injected at
      // document_idle, so every tab already open when the extension is installed, updated or
      // reloaded keeps running WITHOUT one until it reloads. `reinjectAllTabs()` repairs that on
      // install/update, but a tab opened before this build (or one loaded while the worker was
      // starting) can still land here, and Chrome's wording gives the model nothing to act on.
      const message = String(err);
      if (/did not answer within/i.test(message)) {
        return {
          type: 'tool-result',
          ok: false,
          error:
            `${message}. The page may be busy, mid-navigation, or blocked by a modal dialog. ` +
            'Retry once; if it fails again use a different approach rather than repeating it.',
        };
      }
      if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
        return {
          type: 'tool-result',
          ok: false,
          error:
            'No Designer content script in this tab — it was open before the extension was ' +
            'installed or updated. Reload the page (F5) and retry; every DOM tool needs it. ' +
            'Nothing on the page has been changed.',
        };
      }
      return { type: 'tool-result', ok: false, error: message };
    }
  }

  function contentDispatchFor(defaultTabId: number): ContentDispatch {
    return async (message, signal) => {
      if (signal?.aborted) return { type: 'tool-result', ok: false, error: 'aborted' };
      const tabId = message.tabId ?? defaultTabId;
      const frameId = message.frameId ?? 0;
      const send = (): Promise<ToolResult> => sendContentRaw(tabId, frameId, message, signal);
      // Page-driver serialization (#136): EVERY DomTool/ControlTool message rides the per-tab
      // capture lock — not just `screenshot` — so a same-step click/hover/scrollTo/widgetAct/
      // mutation can no longer scroll or shift layout during a full-page stitch's per-band settle
      // windows (silently corrupted bands fed to vision). Pure reads stay outside for throughput
      // (the shared policy set, src/agent/capture-policy.ts). Lock exactly here (not also in
      // screenshotDispatchFor's element branch, which funnels into this) so one call never
      // double-locks and self-deadlocks. The deadlock invariant lives with the policy.
      return shouldRideCaptureLock(message.type) ? withCaptureLock(tabId, send) : send();
    };
  }

  // `screenshot` transport (slice 13). An element/viewport crop routes to content (it computes the
  // rect, the SW crops — the slice-05 path); a `fullPage` capture is SW-owned scroll-stitch of the
  // top document (captureVisibleTab grabs the whole tab viewport, so it ignores `frameId`). The
  // element branch needs no lock of its own — it funnels into contentDispatchFor, where EVERY
  // page-driving message now rides the per-tab lock (#136: the wider driver class — click/hover
  // scrollIntoView, layout-shifting mutations, CDP emulation resizes — is serialized against the
  // stitch, not just the capture pair from #59) — but the stitch must lock: it scrolls the page
  // per band, and any driver dequeued mid-band-settle would corrupt that band's grab.
  function screenshotDispatchFor(defaultTabId: number): ScreenshotDispatch {
    const content = contentDispatchFor(defaultTabId);
    return async (input, signal) => {
      if (signal?.aborted) return { type: 'tool-result', ok: false, error: 'aborted' };
      const tabId = input.tabId ?? defaultTabId;
      // #165 S1 — BOTH branches, before either. `captureVisibleTab` takes no tabId: it grabs
      // whatever is active in the window, so a capture aimed at a background tab (copy mode's
      // reference tab) silently returned the USER's page — element crops with the reference's
      // geometry applied to the wrong image, full-page stitches scrolling one tab while grabbing
      // another. Refuse instead, naming `tabs({action:'activate'})` (see capture-target.ts for
      // why refusing beats auto-activating). Raw `chrome.tabs.get` — no lock re-entry, so the
      // capture-policy deadlock invariant holds.
      const blocked = await captureBlockedReason(probeTab, tabId);
      if (blocked) return { type: 'tool-result', ok: false, error: blocked };
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
      try {
        const tab = await chrome.tabs.get(tabId);
        return {
          type: 'tool-result',
          ok: true,
          data: await withCaptureLock(tabId, () => {
            // Re-checked after the lock wait — the turn may have aborted behind a holder.
            if (signal?.aborted) throw new Error('aborted');
            return captureFullPage(tabId, tab.windowId, signal);
          }),
        };
      } catch (err) {
        // Normalize the abort-throw's 'Error: aborted' to the element path's plain 'aborted'.
        return {
          type: 'tool-result',
          ok: false,
          error: err instanceof Error && err.message === 'aborted' ? 'aborted' : String(err),
        };
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
    // The brief is model-authored, so a keyless hosted provider fails this route too — name it
    // (same guard as a design turn) instead of surfacing a raw 401 from `authorReport`.
    if (keyMissing(cfg)) return { ok: false, error: MISSING_KEY_ERROR };

    // Reuse (or ensure) this tab's design session so the changeset carries the SAME sessionId a
    // turn's `appendTurn` keyed history under — minting a fresh random id here would target a
    // history entry that never existed (`setReport` throws, swallowed → the brief goes unrecorded).
    // A session-less tab (report before any turn) still gets a stable id via `ensure`.
    // NOT an idempotency key, despite what this comment used to claim (#165 S10): `sessionId`
    // appears nowhere under `src/mcp/`, and the dispatched task spec carries no idempotency key at
    // all — a double Ship opens two tasks. Adding one needs the ai-dev side too; deferred in #165.
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
    const target = {
      repo: route.repo,
      backend: route.backend.id,
      ...(route.branch ? { branch: route.branch } : {}),
    };

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
    await lifecycleReady; // session-get / session-state must read the persisted tri-state, not 'idle'
    switch (msg.type) {
      case 'user-message': {
        // Autonomous multi-step turn in the SW: stream tokens + tool-call chips to the panel,
        // route DOM tools to the content script, persist the thread/changeset for resume (04).
        // #168: the turn's id is minted before ANY await and registered as "starting", so a port
        // reconnect during the setup window already reports `turnRunning: true` for this turn.
        // The try/finally guarantees a guard return or a setup throw always unregisters it.
        const turnId = crypto.randomUUID();
        startingTurns.add(turnId);
        try {
          const tab = await resolveTargetTab();
          if (tab?.id === undefined || !tab.url) {
            postToPanel({ type: 'error', message: 'Open a web page to start designing.' });
            return { ok: true } satisfies UserMessageResult;
          }
          const cfg = await getProviderConfig();
          if (!cfg) {
            postToPanel({ type: 'error', message: 'Add a model provider in Settings to start.' });
            return { ok: true } satisfies UserMessageResult;
          }
          // Fail here, named, rather than let the SDK issue a keyless request and surface the
          // provider's own wording ("Missing Authentication header") several frames deep in the
          // stream. Readiness blocks Start on the same condition; this covers a key cleared after
          // Start, and a session restored into a worker whose stored key has since gone.
          if (keyMissing(cfg)) {
            postToPanel({ type: 'error', message: MISSING_KEY_ERROR });
            return { ok: true } satisfies UserMessageResult;
          }
          const tabId = tab.id;
          // Closure-stable alias (TS drops a captured property's narrowing inside the chained
          // rehydration closure below — same reason `tabId` is aliased).
          const tabUrl = tab.url;

          // Supersede any in-flight turn, then run this one under a fresh abort controller (Stop /
          // a newer instruction aborts it). Session-start/-stop share `turnAbort` (slice 03).
          // The new controller is installed BEFORE the settlement wait below so the supersede
          // window never reports `turnRunning: false`, and so the aborted turn's `.finally` sees
          // itself non-current (it must not emit `turn-done` or null a controller it no longer owns).
          const priorTurn = settlingTurn;
          turnAbort?.abort();
          const controller = new AbortController();
          turnAbort = controller;
          runningTurnId = turnId;

          // #168 ordering: ONE source of truth for the thread order. The aborted turn's (or a
          // stopped turn's still-running) finalization appends its REAL messages (partial included)
          // to the session thread; this message must land AFTER them, so await that finalization —
          // bounded, so a provider that hangs on abort can't hold the new turn hostage. Missing the
          // bound FORFEITS the old turn: its late finalization skips the append instead of writing
          // behind this user message (the residual race — forfeit flagged between its check and its
          // append — is a single microtask and loses only that partial, never the order).
          if (priorTurn) {
            const settledInTime = await Promise.race([
              priorTurn.done.then(() => true),
              browseDelay(SUPERSEDE_SETTLE_MS).then(
                () => false,
                () => false,
              ),
            ]);
            if (!settledInTime) forfeitedTurns.add(priorTurn.id);
          }

          // This turn's device-emulation owner + the driver BOUND to it: the driver stamps the owner
          // on any attach/resize, so a superseded turn's teardown (below) only clears the emulation
          // IT applied, never one a newer concurrent same-tab turn has since taken over. The owner is
          // a constructor argument, not a module-level global read after an await (#165 S3).
          const emulationOwner = crypto.randomUUID();
          const deviceDriver = deviceDriverFor(emulationOwner);
          // Every tab this turn emulated (the model can target other tabs, e.g. copy mode's
          // reference tab, and can emulate several in one turn) — the teardown below restores each
          // of them, not just the turn's default tab. A `reset` removes the tab from the set.
          const emulatedTabs = new Set<number>();

          const ensured = await sessions.ensure(tabId, tab.url, crypto.randomUUID());

          // Copy/debug mode (slice 06): an explicit choice wins, else infer from the instruction
          // WITH the session's last resolved mode as the sticky fallback (#168 E) — "now fix the
          // padding too" three messages into a debug session stays a debug turn. Resolved BEFORE
          // the user append because the mode's guidance now rides the user message (below). The
          // resolution is persisted back so the next turn's inference starts from it.
          const mode = resolveMode(msg.mode, msg.text, ensured.lastMode);
          const guidance = modeGuidance(mode);

          // Ground the instruction in the picker's selection (#165 S6): the panel echoes the
          // still-attached element(s) on `selector`/`selectors`, and the grounded text — not the raw
          // text — goes into the thread, so a turn resumed after an SW eviction still knows what
          // "this" referred to. History keeps the user's own words (`msg.text`, below).
          // The mode's per-turn guidance (`turnAddendum`) is appended to the SAME message — never
          // to the system prompt, which must stay byte-stable across turns for prefix caching
          // (#168; `ModeGuidance.addenda` is always empty now, see modes.ts). It rides the
          // PERSISTED thread too, deliberately: the next turn rebuilds the model input from the
          // thread, and a persisted message differing from what the model actually saw would
          // break the cached prefix.
          const groundedText = groundUserText(msg.text, msg.selector, msg.selectors, msg.xpath);
          const turnText = guidance.turnAddendum
            ? `${groundedText}\n\n${guidance.turnAddendum}`
            : groundedText;
          const session = await sessions.appendMessages(tabId, {
            role: 'user',
            content: turnText,
          });

          // The turn is live: persist it per-tab so a panel reconnecting to a WOKEN worker can tell
          // an orphaned turn from a live one (#165 S5, `session-get`), along with the resolved mode.
          await sessions.patch(tabId, { status: 'running', lastMode: mode }).catch(() => {});

          // Browser-control + vision dispatches (slice 13) — the loop builds the tools from these
          // (`interact`/`tabsFrames`/`vision`) and wraps `waitFor`/`navigate*`/`inspectVisually`
          // with its budget guards, so construction lives in one place (`loop.ts` `buildTools`)
          // and stays consistent with the DOM/browse tools instead of being assembled ad hoc here.
          // `content` drives the page (DOM + interaction) in the target frame; nav/tabs/frames run
          // SW-side against `chromeBrowserDriver`; vision captures + inspects.
          const model = createProvider(cfg);
          // #168 prompt-cache opt-in: Anthropic-via-OpenRouter honours explicit `cache_control`
          // breakpoints forwarded from the request JSON, but a strict OpenAI-compatible endpoint
          // may reject the unknown field — so BOTH annotations are gated on the configured
          // baseURL being OpenRouter (prompt-cache.ts's opt-in doctrine). Placement: one
          // breakpoint after the byte-stable system prompt, one on the last message of the PRIOR
          // thread (the new user message + this turn's steps grow past it without invalidating
          // it). Annotations are per-request only — the persisted thread stays clean.
          const cacheable = isOpenRouterBase(cfg.baseURL);
          const systemPrompt = buildSystemPrompt();
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
            // Top frame only — same reason as `set-overlay-enabled` below.
            void chrome.tabs.sendMessage(tabId, cmd, { frameId: 0 }).catch(() => {});
          }
          const emitTurn = (update: SwToPanel): void => {
            // #168 A: every per-turn stream event carries this turn's id, so the panel folds ONLY
            // same-turn events into its in-flight bubble (a second window's turn can't bleed in).
            postToPanel(stampTurnId(update, turnId));
            forwardOverlayStep(update);
          };

          // The session/recorder tools (slice 07): `recordEdit`/`undo`/`redo` mutate this tab's
          // changeset, `handoff` only proposes (gated below — never auto-ships). Rehydrate the
          // undo/redo-capable store from its own `chrome.storage.session` record (falling back to
          // the resume-context changeset `sessions.ensure` above just loaded/created), and mirror
          // every mutation to BOTH: the redo-capable record (`changesetPersister`, this store's own
          // durability) and `SessionStore` (`sessions.setChangeset`, so `runHandoffRoute`'s Ship/
          // report reads see the edit immediately, without waiting for the turn to finish). The
          // whole rehydration rides the per-tab mutation chain (#142 item 1): a curation op whose
          // save→mirror tail is still in flight settles first, so this load seeds from the
          // POST-curation record instead of persisting the pre-op state over it.
          const { changesetStore, persistChangeset } = await enqueueChangesetMutation(
            tabId,
            async () => {
              const changesetPersister = createSessionChangesetPersister(tabId);
              const priorChangesetState = await changesetPersister.load();
              // Turn-start URL guard (#9 review): the persister record (and the session mirror it
              // falls back to) can hold a changeset for a URL the tab has since left — the nav-clear
              // wipe is async and a between-turns navigation can race it. Edits recorded against
              // another page must never fold into this turn's record, so on mismatch BOTH mirrors
              // start EMPTY for the tab's current committed URL (redo stack dropped too — it only
              // references the old record's edits). The comparison runs against the last
              // CROSS-DOCUMENT committed URL, not the live `tab.url`: a same-document navigation
              // (hash change, history.pushState) fires no commit, leaves DOM + live edits intact, and
              // must not wipe the record (#9 review round 2). The committed URL is read from
              // chrome.storage.session FIRST (#9 review round 4): it survives the SW eviction the
              // in-memory `lastCommittedUrl` map doesn't, so a woken SW no longer falls straight
              // through to `tab.url` and false-wipes on a hash change; the map then the live
              // `tab.url` remain the fallbacks for a tab no commit was ever seen for. This closes
              // the BETWEEN-turns race only; a mid-turn in-flight rebase is tracked in issue #148.
              const priorChangeset = priorChangesetState?.changeset ?? session.changeset;
              const staleRecord =
                priorChangeset.url !==
                ((await readCommittedUrl(tabId)) ?? lastCommittedUrl.get(tabId) ?? tabUrl);
              const store = new ChangesetStore(
                staleRecord
                  ? // Re-seed EMPTY for the new URL but KEEP the session's conversation id (#168
                    // L6): history is keyed by it, so minting a fresh id here forked the history
                    // conversation on every cross-document nav (and could evict an older one).
                    // Safe to carry over — it is NOT an idempotency key (#165 S10). Edits are
                    // still wiped; only the history/thread identity survives the nav.
                    emptyChangeset(tabUrl, new Date().toISOString(), session.changeset.sessionId)
                  : priorChangeset,
                { redoStack: staleRecord ? undefined : priorChangesetState?.redoStack },
              );
              // Named (not inline) so the turn-done auto-finalize below records + persists + streams
              // leftover recorder groups through the exact same path as a model-called `recordEdit`.
              const persist = async (): Promise<void> => {
                await changesetPersister.save(store.snapshot());
                await sessions.setChangeset(tabId, store.current);
              };
              // A stale (cross-URL) record was re-seeded above: write the empty changeset to BOTH
              // mirrors now, so neither the persister nor the session mirror can resurrect the old
              // page's edits on a later load.
              if (staleRecord) await persist();
              // Register the turn's store for the mid-turn half of the recorder-revert retraction
              // (retractRevertedEdit strips the reverted event's contribution here too, so this
              // store's next persist can't resurrect the phantom over the op's retraction).
              turnChangeset = { tabId, store, persist };
              return { changesetStore: store, persistChangeset: persist };
            },
          );
          // Stamp this turn's tab onto its record pushes: a Diff view keyed to ANOTHER tab drops
          // them instead of folding phantom rows (the turn keeps running when the user switches
          // tabs mid-turn; the retargeted view heals on the settle refresh). #141 review.
          const emitRecord = (update: SwToPanel): void => {
            postToPanel(
              update.type === 'edit-recorded' || update.type === 'changeset'
                ? { ...update, tabId }
                : update,
            );
          };
          const sessionTools = createSessionTools({
            store: changesetStore,
            persist: persistChangeset,
            emit: emitRecord,
            // #9: `recordEdit` drains this tab's buffered recorder events for its selector and
            // folds their real mechanical deltas into the Edit (ground truth wins per family).
            drainRecorderEvents: (selectorValue) => pendingMutations.drain(tabId, selectorValue),
          });

          // Fire-and-forget: the turn streams over the port for its lifetime, so the RPC acks now
          // (unblocking the panel). Completion persists the REAL turn messages + spend. The whole
          // chain (it never rejects — `.catch` below) is registered as `settlingTurn` so the NEXT
          // user-message can await this turn's persistence before appending its own (#168 B).
          // Running cumulative session spend: seeded from the session's prior total, advanced in
          // `.then()`, and surfaced to the panel's usage meter on `turn-done` (#25).
          let sessionUsage = session.usage;
          const turnDone = runTurn({
            tabId,
            messages: cacheable ? annotatePriorThreadTail(session.messages) : session.messages,
            signal: controller.signal,
            model,
            instructions: cacheable ? cachedSystemPrompt(systemPrompt) : systemPrompt,
            dispatch: content,
            browse: (input, signal) => runBrowse(chromeBrowseDriver, input, signal),
            interact: {
              control: content,
              // Same-tab nav drivers ride the per-tab capture lock (#146): a navigate/back/
              // reload issued while a full-page stitch is in flight would unload the content
              // script mid-stitch — and captureVisibleTab inside the navigation window can grab
              // a stale/transition frame into a band SILENTLY. The lock keys on the RESOLVED
              // tab (the model can pass `tabId` — a copy-mode reference tab), exactly like the
              // emulation wrappers below. Deadlock-invariant-safe: runNav's internals are raw
              // chrome.tabs calls that never re-enter the locking dispatch.
              nav: (msg, signal) =>
                withCaptureLock(msg.tabId ?? tabId, () =>
                  runNav(chromeBrowserDriver, msg, tabId, signal),
                ),
            },
            tabsFrames: {
              // tabs.close rides the target tab's lock too (#146) — closing a stitching tab
              // mid-band is the same corruption class; the close queues behind the stitch
              // instead. open/activate/list mutate no captured tab (activate targets the
              // WINDOW, which a per-tab lock can't express — documented residual, pre-#146).
              tabs: (msg) =>
                msg.action === 'close' && msg.tabId !== undefined
                  ? withCaptureLock(msg.tabId, () => runTabs(chromeBrowserDriver, msg))
                  : runTabs(chromeBrowserDriver, msg),
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
            // SW-owned (chrome.debugger CDP + chrome.tabs capture) and run against this turn's OWN
            // `deviceDriver`; `checkResponsive` is content-routed (scanner runs in the page). Both
            // emulation entry points ride the per-tab capture lock (#136): a same-step setDevice or
            // responsive sweep resizing the viewport mid-stitch invalidates every band's planned
            // geometry. The lock keys on the RESOLVED tab (the model can pass `tabId` — a copy-mode
            // reference tab), and the turn records which tab it emulated so its teardown (the
            // `finally` below) restores the right one. The sweep holds the lock for its WHOLE
            // duration — so its internal captures must use RAW paths (never the locking dispatches,
            // which would queue it behind itself): fullPage calls captureFullPage directly (its
            // internals are lock-free by the deadlock invariant), element/viewport shots ride
            // `sendContentRaw`. The fullPage branch try/catches into a per-shot error ToolResult —
            // one failed breakpoint must not reject the whole sweep (device-emulation.ts's
            // "never an aborted sweep" contract).
            responsive: {
              setDevice: (message) => {
                const target = message.tabId ?? tabId;
                // Track the emulation for the turn's teardown: a real apply adds the tab; a `reset`
                // restores it immediately (runSetDevice) so it leaves the set (a bare reset must not
                // clobber the record of a tab still emulated from earlier in the turn).
                if (message.reset) emulatedTabs.delete(target);
                else emulatedTabs.add(target);
                return withCaptureLock(target, () => runSetDevice(deviceDriver, message, tabId));
              },
              capture: (message, signal) => {
                const target = message.tabId ?? tabId;
                emulatedTabs.add(target);
                return withCaptureLock(target, () =>
                  runResponsiveCapture(
                    deviceDriver,
                    async (t, opts, sig) => {
                      // #165 S1 again, per breakpoint: the sweep applies emulation to `t` and then
                      // captures — against the ACTIVE tab if `t` isn't it, so every shot in the set
                      // would be the wrong page rendered at the wrong size. A per-shot error keeps
                      // the sweep's "never an aborted sweep" contract.
                      const inactive = await captureBlockedReason(probeTab, t);
                      if (inactive) return { type: 'tool-result', ok: false, error: inactive };
                      if (opts.fullPage) {
                        try {
                          const tab = await chrome.tabs.get(t);
                          const result: ToolResult = {
                            type: 'tool-result',
                            ok: true,
                            data: await captureFullPage(t, tab.windowId, sig),
                          };
                          return result;
                        } catch (err) {
                          // The pre-lock path normalized these (closed tab, capture quota, abort) —
                          // keep the per-shot-error contract (normalize 'Error: aborted' to
                          // 'aborted', mirroring screenshotDispatchFor).
                          return {
                            type: 'tool-result',
                            ok: false,
                            error:
                              err instanceof Error && err.message === 'aborted'
                                ? 'aborted'
                                : String(err),
                          };
                        }
                      }
                      return sendContentRaw(
                        t,
                        0,
                        { type: 'screenshot', selector: opts.selector, tabId: t },
                        sig,
                      );
                    },
                    (sig) => browseDelay(EMULATION_SETTLE_MS, sig),
                    message,
                    tabId,
                    signal,
                  ),
                );
              },
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
              // #168 B: persist the REAL turn — `compactForThread` over the SDK's response
              // messages (tool calls + results included), not a flat prose message — on EVERY
              // completion path: done, budget, error, user Stop, supersede. The one exception is a
              // FORFEITED turn (its superseder stopped waiting): its user message is already, or
              // is about to be, appended, so a late append here would land behind it and corrupt
              // the resume order — that partial is dropped, order wins.
              const forfeited = forfeitedTurns.has(turnId);
              let compacted: ChatMessage[] = [];
              if (!forfeited) {
                try {
                  compacted = compactForThread(outcome.responseMessages);
                  if (compacted.length > 0) await sessions.appendMessages(tabId, ...compacted);
                } catch (err) {
                  // #168 F: a persistence failure is NOT a turn failure. Log + surface it
                  // UNATTRIBUTED (no turnId) — the panel doesn't fold turnless errors into turn
                  // state — so the streamed reply stands while the user still learns the resume
                  // thread may be short.
                  console.warn(`[turn] failed to persist the thread for tab ${tabId}:`, err);
                  postToPanel({
                    type: 'error',
                    message: `Could not save this turn to the conversation thread: ${String(err)}`,
                  });
                }
                // #168 D: history gets the SAME compacted tool-bearing messages, so a replay shows
                // the tool activity (history-store's tool-unit pairing finally has real input).
                // The user's own words lead the turn (`msg.text`, not the grounded text). History
                // is keyed by the changeset's sessionId (stable across turns AND, since #168 L6,
                // across cross-document navs) so the whole design session stays ONE conversation.
                // Quiet failure: history is a convenience copy — console.warn only, never an
                // error push the panel could misread as the turn failing (#168 M5).
                try {
                  await historyStore.appendTurn({
                    id: changesetStore.current.sessionId,
                    title: msg.text,
                    url: changesetStore.current.url,
                    mode,
                    messages: [{ role: 'user' as const, content: msg.text }, ...compacted],
                  });
                } catch (err) {
                  console.warn(`[turn] failed to append history for tab ${tabId}:`, err);
                }
              }
              // Everything below is current-lineage only: a superseded/Stopped turn's spend stays
              // uncounted (the meter is approximate, hence "~") and its recorder leftovers stay
              // buffered for the turn that replaced it (or the nav-clear below wipes them).
              if (turnAbort !== controller) return;
              sessionUsage = {
                steps: sessionUsage.steps + outcome.usage.steps,
                tokens: sessionUsage.tokens + outcome.usage.tokens,
              };
              await sessions.patch(tabId, { usage: sessionUsage }).catch((err) => {
                console.warn(`[turn] failed to persist usage for tab ${tabId}:`, err);
              });
              // #9 auto-finalize: mutation groups the model never recorded (no `recordEdit` call
              // drained them) still land in the durable changeset — one "Auto-recorded" Edit per
              // remaining selector group, folded from the real events, recorded + persisted +
              // streamed exactly like a model-recorded edit. A group holding several structural
              // ops splits: the first stays in the folded edit, each additional op becomes its own
              // auto-recorded spillover Edit. Events dropped at the buffer cap are surfaced as an
              // intent suffix on the FIRST finalized edit only — the loss is tab-level, so one
              // note covers it (and `recordEdit`'s drain already claimed + reset the counter for
              // anything it folded). Then the tab's buffer is wiped. Runs only on the
              // still-current turn (the guard above): a superseded turn's leftovers stay buffered
              // for the turn that replaced it (or the nav-clear below wipes them).
              try {
                const droppedAtCap = pendingMutations.droppedCount(tabId);
                let capNote =
                  droppedAtCap > 0
                    ? ` (+${droppedAtCap} earlier events dropped at buffer cap)`
                    : '';
                for (const group of pendingMutations.peekGroups(tabId)) {
                  const { folded, spillover } = foldMutationEvents(
                    {
                      intent: 'Auto-recorded agent edit (no recordEdit call)',
                      selector: group.selector,
                      changes: [],
                      attrs: [],
                      classes: [],
                      frameworkHints: [],
                    },
                    group.events,
                  );
                  for (const edit of [folded, ...spillover]) {
                    const tagged = capNote ? { ...edit, intent: `${edit.intent}${capNote}` } : edit;
                    capNote = ''; // tab-level loss: noted once, on the first finalized edit
                    changesetStore.record(tagged);
                    await persistChangeset();
                    emitRecord({ type: 'edit-recorded', edit: tagged });
                  }
                }
                pendingMutations.clear(tabId);
              } catch (err) {
                // #168 F: changeset persistence trouble is surfaced unattributed too — the turn
                // itself finished; conflating the two made the panel misread "turn failed".
                console.warn(`[turn] auto-finalize failed for tab ${tabId}:`, err);
                postToPanel({
                  type: 'error',
                  message: `Could not record the turn's remaining edits: ${String(err)}`,
                });
              }
            })
            .catch((err) => {
              // #168 F: narrowed — every persistence step above handles its own failure, so only
              // an unexpected `runTurn` throw (or a programming error in the finalization scaffold)
              // lands here, and that one IS this turn's failure: turn-scoped, turnId stamped.
              postToPanel({ type: 'error', message: String(err), turnId });
            })
            .finally(() => {
              // Same "still current" guard as the `.then()` above: a superseded turn (newer
              // user-message) or one Stop already cleared `turnAbort` and pushed `session-state:
              // 'stopped'` itself (case 'session-stop') — that already tells the chat store (11) the
              // turn is done, so this natural-completion signal only fires for the turn that's still
              // the one in flight.
              const wasCurrent = turnAbort === controller;
              if (wasCurrent) {
                turnAbort = null;
                runningTurnId = null;
                // Unregister the mid-turn retraction target with the turn — a dead turn's store
                // must never receive another strip (see retractRevertedEdit).
                turnChangeset = null;
              }
              // This turn's supersede bookkeeping dies with it: a settled turn no longer needs to
              // be awaited, and its forfeit mark (checked in the `.then` above) must not leak.
              if (settlingTurn?.id === turnId) settlingTurn = null;
              forfeitedTurns.delete(turnId);
              // The turn is over: clear the persisted per-tab turn status so a later `session-get`
              // doesn't read a stale `'running'` and report an orphan (#165 S5). A superseded turn
              // does NOT write here — the turn that replaced it already stamped `'running'`, and
              // overwriting would make the live turn look finished.
              if (wasCurrent) void sessions.patch(tabId, { status: 'idle' }).catch(() => {});
              // Tear down device emulation ONLY for tabs this turn still owns (detach the debugger /
              // restore the window) so the user's page + the "being debugged" banner don't outlast the
              // turn — but never clear emulation a newer concurrent same-tab turn has taken over.
              for (const emuTab of emulatedTabs) {
                if (!emulation.owns(emuTab, emulationOwner)) continue;
                // Ride the capture lock too (#136): a concurrent same-tab stitch (a newer turn's)
                // must not see its viewport resized mid-capture by this turn's teardown. Ownership
                // is RE-CHECKED inside the lock callback: the queue wait is a TOCTOU window in which
                // a superseding turn's setDevice may have stamped its own owner — restoring now
                // would kill that newer turn's fresh emulation mid-turn.
                void withCaptureLock(emuTab, () => {
                  if (!emulation.owns(emuTab, emulationOwner)) return Promise.resolve();
                  return restoreDevice(deviceDriver, emuTab);
                }).catch(() => {});
              }
              if (wasCurrent) postToPanel({ type: 'turn-done', usage: sessionUsage, turnId });
            });
          // Register the chain for the NEXT user-message's ordered supersede (see the wait above).
          settlingTurn = { id: turnId, done: turnDone };

          // #168 A: ack with the turn's id so the panel keys its in-flight bubble to this turn's
          // stream events (which all carry the same id via `emitTurn`).
          return { ok: true, turnId } satisfies UserMessageResult;
        } finally {
          startingTurns.delete(turnId);
        }
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
      case 'stop-picker':
      // A chip's dismiss rides the same relay: the picker's committed selection lives in the
      // content world, so forgetting a reference only in the panel let the next
      // `multi-select-changed` echo bring it straight back (and ground the agent on it).
      case 'deselect-element': {
        const tab = await resolveTargetTab();
        if (tab?.id !== undefined) {
          const cmd: PickerCmd =
            msg.type === 'start-picker'
              ? { type: 'picker-start' }
              : msg.type === 'stop-picker'
                ? { type: 'picker-stop' }
                : { type: 'picker-deselect', value: msg.value };
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
        mcpManager.register(mcpSpec(stored), { enabled: stored.enabled });
        pushMcpStatus(stored);
        void pushReadiness().catch(() => {});
        return { ok: true, server: await toBusServer(stored) };
      }
      // Tear down the connection and purge the persisted record + both credential slots
      // (mcp/store.ts removeServer already clears the key-store side).
      case 'mcp-remove':
        await mcpManager.unregister(msg.id);
        oauthConfigs.delete(msg.id);
        await removeServer(msg.id);
        await clearToolGrants(msg.id); // #120: no orphaned grant survives a removal
        void pushReadiness().catch(() => {});
        return { ok: true };
      case 'mcp-list': {
        const servers = await Promise.all((await listServers()).map((s) => toBusServer(s)));
        return { ok: true, servers };
      }
      // (Re)open a registered server and refresh its cached health/tool catalog.
      // McpManager.connect never throws — a failed open comes back as status:'error'.
      // A disabled server (#17) refuses before any open is attempted.
      case 'mcp-connect': {
        const stored = await getServer(msg.id);
        if (!stored) return { ok: false, error: `Unknown MCP server: ${msg.id}` };
        if (!stored.enabled) return { ok: false, error: `MCP server is disabled: ${stored.label}` };
        if (!mcpManager.has(msg.id)) mcpManager.register(mcpSpec(stored));
        await mcpManager.connect(msg.id);
        pushMcpStatus(stored);
        void pushReadiness().catch(() => {});
        return { ok: true, server: await toBusServer(stored) };
      }
      // Enable/disable a backend (#17): persist the flag, flip the manager registration
      // (disabling tears the live connection down), republish health + readiness (the MCP
      // row counts ENABLED servers only).
      case 'mcp-set-enabled': {
        const stored = await getServer(msg.id);
        if (!stored) return { ok: false, error: `Unknown MCP server: ${msg.id}` };
        const next = await saveServer({ ...stored, enabled: msg.enabled });
        if (!mcpManager.has(msg.id)) mcpManager.register(mcpSpec(next), { enabled: next.enabled });
        await mcpManager.setEnabled(msg.id, msg.enabled);
        pushMcpStatus(next);
        void pushReadiness().catch(() => {});
        return { ok: true, server: await toBusServer(next) };
      }
      // Per-tool opt-in (#120): grant/revoke one write-shaped tool for the design loop. The
      // grant takes effect on the NEXT turn's toolsFor merge (a running turn keeps its set).
      case 'mcp-tool-grant-set': {
        const stored = await getServer(msg.id);
        if (!stored) return { ok: false, error: `Unknown MCP server: ${msg.id}` };
        await setToolGrant(msg.id, msg.tool, msg.granted);
        pushMcpStatus(stored);
        return { ok: true, server: await toBusServer(stored) };
      }
      // Origin→repo map (#20): the one-click-Ship mapping the panel curates. The SW validates
      // nothing beyond the bus schema — the map is user-curated by construction, and a bogus
      // slug only ever fails the user's own backend task create.
      case 'mcp-origin-repo-get':
        return { ok: true, map: await getOriginRepoMap() };
      case 'mcp-origin-repo-set':
        await setOriginRepo(msg.origin, msg.entry);
        return { ok: true };
      case 'mcp-origin-repo-clear':
        await clearOriginRepo(msg.origin);
        return { ok: true };
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
        mcpManager.register(mcpSpec(next), { enabled: next.enabled });
        await mcpManager.connect(msg.id);
        pushMcpStatus(next);
        void pushReadiness().catch(() => {});
        return { ok: true, server: await toBusServer(next) };
      }
      // Manual refresh: republish every registered server's current health on the
      // mcp-status stream (e.g. a panel that just (re)connected with no cached state).
      case 'mcp-status':
        for (const stored of await listServers()) pushMcpStatus(stored);
        return { ok: true };

      // --- readiness + session (slice 03) ---------------------------------
      case 'readiness':
        return { ok: true, state: await computeReadiness(mcpManager) };
      // Marks the session active (primes the agent — see 04) and flips the panel from
      // the readiness/empty state to chat. A stale in-flight turn from a prior session
      // is aborted first so it can never leak tokens into the new one.
      case 'session-start':
        turnAbort?.abort();
        turnAbort = null;
        runningTurnId = null;
        turnChangeset = null;
        setSessionState('running');
        return { ok: true };
      // Aborts the in-flight agent turn (04 sets `turnAbort` at turn-start) without
      // ending the session — the panel stays on chat, ready for the next message.
      case 'session-stop':
        // Aborting still lets the turn's finalization persist its REAL partial messages to the
        // session thread (#168 B): the `.then` persistence path is unconditional (not gated on
        // "still current"), so a Stop-then-send never produces a [user, user] adjacency — the
        // next user-message additionally awaits `settlingTurn` before appending.
        turnAbort?.abort();
        turnAbort = null;
        runningTurnId = null;
        turnChangeset = null;
        setSessionState('stopped');
        return { ok: true };
      // The panel ASKS for the current state (#165 S5) — the recovery path for a panel that
      // reconnected to a worker woken after a mid-turn eviction, where no transition will ever be
      // pushed because the transition already happened in a worker that is gone. Two facts, and
      // the per-tab turn status is HEALED on the way out: a persisted `'running'` with no live
      // `turnAbort` can only be an orphan, so it becomes `'stopped'` here and stays that way.
      case 'session-get': {
        const tab = await resolveTargetTab();
        const tabId = tab?.id ?? null;
        const turnRunning = isTurnRunning();
        const current = tabId === null ? undefined : sessions.get(tabId);
        if (tabId !== null && current) {
          const healed = reconcileTurnStatus(current.status, turnRunning);
          // Best-effort: the answer above is already correct, and a failed write only means the
          // next ask re-derives the same thing.
          if (healed !== current.status) {
            await sessions.patch(tabId, { status: healed }).catch(() => {});
          }
        }
        // #168 A: name the in-flight turn so a reconnecting panel can match its orphaned bubble
        // against the stream's turnId-stamped events. Only while one is actually running/starting.
        const currentTurnId = turnRunning ? liveTurnId() : undefined;
        return {
          ok: true,
          state: sessionState,
          turnRunning,
          tabId,
          ...(currentTurnId !== undefined ? { currentTurnId } : {}),
        } satisfies SessionStateResult;
      }
      // The SW-side conversation thread for the active tab, rendered down to a view the panel can
      // replace its lossy replica with (#168 C). Same tab resolution as `session-get`; the reply
      // is tab-stamped so the panel can't fold one tab's thread into another's transcript. The
      // heavy provider parts (tool payloads, images) NEVER cross the bus — `toThreadView` distills
      // them to text + per-tool outcomes.
      case 'thread-get': {
        const tab = await resolveTargetTab();
        const tabId = tab?.id ?? null;
        if (tabId === null) {
          return {
            ok: false,
            tabId,
            error: 'Open a web page first.',
          } satisfies ThreadGetResult;
        }
        const session = sessions.get(tabId);
        if (!session) {
          return {
            ok: false,
            tabId,
            error: 'No design session for this tab yet.',
          } satisfies ThreadGetResult;
        }
        return {
          ok: true,
          tabId,
          thread: toThreadView(session.messages),
        } satisfies ThreadGetResult;
      }

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
        // Report whether the push landed instead of swallowing the failure: no content script in
        // the active tab (a tab open since before the extension was installed/reloaded, or a
        // chrome:// page) means nothing on that page will react until it reloads — and silently
        // showing "On" over a page with no overlay is the single most common way this feature
        // looks broken. The panel turns this into a "reload the page" hint.
        let reachedPage = false;
        if (tab?.id !== undefined) {
          const cmd: OverlayCmd = { type: 'overlay-toggle', enabled: overlayEnabled };
          // frameId 0: the overlay is top-frame only (content.ts gates it on `isTopFrame`), so
          // addressing every frame would wake N listeners for one card and leave the ack racing
          // between frames that don't own it.
          reachedPage = await chrome.tabs
            .sendMessage(tab.id, cmd, { frameId: 0 })
            .then((reply) => OverlayAck.safeParse(reply).success)
            .catch(() => false);
        }
        return { ok: true, enabled: overlayEnabled, reachedPage };
      }
      case 'get-overlay-enabled':
        return { ok: true, enabled: overlayEnabled };

      // --- first-run onboarding guide, dismissed flag (slice 24) ----------
      // Panel-only presentation state (which surface to show) — just persist/read it, no
      // in-memory SW flag and no tab push (nothing on the page reacts to it).
      case 'set-onboarding-dismissed':
        await writeOnboardingDismissed(msg.dismissed);
        return { ok: true, dismissed: msg.dismissed };
      case 'get-onboarding-dismissed':
        return { ok: true, dismissed: await readOnboardingDismissed() };

      // --- diff review: changeset curation from the Diff tab (slice 10) ----
      // Curate the DURABLE, shippable changeset the agent's recordEdit/undo/redo tools also drive
      // (src/agent/tools/session.ts), per-tab in chrome.storage.session. `changeset-get` is a pure
      // read; the four mutators walk history / drop one edit / wipe the session — the shippable
      // record only, never the live page (edits are ephemeral). The op result is BOTH replied and
      // pushed as a `changeset` so any other open panel stays in sync.
      case 'changeset-get': {
        let tabId: number | null = null;
        try {
          const tab = await resolveTargetTab();
          tabId = tab?.id ?? null;
          if (tabId === null)
            return { ok: true, tabId, changeset: null, canUndo: false, canRedo: false };
          const persister = createSessionChangesetPersister(tabId);
          return { ok: true, tabId, ...(await readChangeset(persister.load)) };
        } catch (e) {
          // Schema-conformant error reply — the panel parses every reply with ChangesetResult, so a
          // bare `{ok:false,error}` from the outer wrapper would surface as "malformed response".
          return {
            ok: false,
            tabId,
            changeset: null,
            canUndo: false,
            canRedo: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }
      case 'changeset-undo':
      case 'changeset-redo':
      case 'changeset-clear':
      case 'changeset-remove-edit': {
        let tabId: number | null = null;
        try {
          const tab = await resolveTargetTab();
          tabId = tab?.id ?? null;
          if (tabId === null)
            return { ok: false, tabId, changeset: null, canUndo: false, canRedo: false };
          // Closure-stable alias (TS drops a captured `let`'s narrowing inside the mirror closure).
          const curTabId = tabId;
          // The panel curates the record it DISPLAYS: it sends that tab as `forTabId`, and the
          // active tab is re-resolved here per RPC. A disagreement means the panel's view is
          // stale (a tab switch since mount) — refuse rather than mutate the record of a tab the
          // user isn't looking at; the panel refreshes to the newly active tab (#141 review).
          if (msg.forTabId !== undefined && msg.forTabId !== curTabId)
            return {
              ok: false,
              tabId,
              changeset: null,
              canUndo: false,
              canRedo: false,
              error: 'tab-drift',
            };
          const persister = createSessionChangesetPersister(curTabId);
          // Reject while a turn is in flight: the running turn owns its own ChangesetStore and persists
          // after every tool call, so a panel op loading a fresh store from storage would clobber it.
          // Return the current state so the panel can reflect it + show a "busy" hint (never throws).
          if (turnAbort)
            return { ok: false, busy: true, tabId, ...(await readChangeset(persister.load)) };
          const op: ChangesetOp =
            msg.type === 'changeset-undo'
              ? { kind: 'undo' }
              : msg.type === 'changeset-redo'
                ? { kind: 'redo' }
                : msg.type === 'changeset-clear'
                  ? { kind: 'clear' }
                  : { kind: 'remove', index: msg.index };
          const result = await enqueueChangesetMutation(curTabId, () =>
            applyChangesetOp(
              {
                load: persister.load,
                save: persister.save,
                // Mirror onto the SessionStore so a subsequent Ship/report read sees the curated record.
                // Best-effort: `setChangeset` throws if the tab has no live session (evicted mid-edit),
                // which must not fail the curation — the persister above is the source of truth.
                mirror: (cs) =>
                  sessions
                    .setChangeset(curTabId, cs)
                    .then(() => undefined)
                    .catch(() => undefined),
                // Re-checked once after the load resolves: the pre-load `turnAbort` check alone is
                // check-then-act — a turn that starts inside the load window must win, so abort the
                // op as busy rather than persist over the turn's rehydrated store (#141 review).
                // The save→mirror TAIL needs no such check: the turn's rehydration rides the same
                // per-tab chain, so it can only load after this op fully settles (#142 item 1).
                guard: () => turnAbort === null,
              },
              op,
            ),
          );
          const { busy, ...view } = result;
          if (busy) return { ok: false, busy: true, tabId, ...view };
          // Stamp the tab so a panel showing ANOTHER tab's record can drop this push.
          if (view.changeset)
            postToPanel({ type: 'changeset', changeset: view.changeset, tabId: curTabId });
          return { ok: true, tabId, ...view };
        } catch (e) {
          return {
            ok: false,
            tabId,
            changeset: null,
            canUndo: false,
            canRedo: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }
    }
  }

  // Cross-turn undo phantom retraction (#9 review round 2; op-ified + mid-turn strip in round
  // 4; shared matcher + fail-closed drop + redo-tail preservation in round 5): a recorder-revert
  // whose event already left the pending buffer (drained by `recordEdit`, or auto-finalized at
  // turn end) means the durable record holds an edit for a page change that no longer exists.
  // Retract it through the SAME applyChangesetOp machinery the Diff-tab curation RPCs drive —
  // ONE load (the round-2 find-index-then-remove double-load was a TOCTOU window): the op calls
  // retractFromEdits, the ONE matcher both paths share, which strips ONLY the reverted event's
  // contribution from the newest consistent edit whose strip changes something (a fully-stripped
  // edit is removed), and — when NO consistent edit value-matches, a broken LIFO — fails closed
  // by dropping the entries the event covers from the newest consistent edit instead of keeping
  // the phantom. Both splices pass `{ preserveRedo: true }`: a retract of an unrelated edit must
  // not silently kill a redo tail earned before it. Persist + SessionStore mirror + tab-stamped
  // panel push come with it. Unlike the curation RPCs there is deliberately NO turn-in-flight
  // guard: the revert is page ground truth (the change is gone), so the retraction is attempted
  // best-effort even mid-turn. The MID-TURN case additionally retracts the same event from the
  // turn's OWN in-memory store — otherwise its next `persistChangeset` would write the phantom
  // straight back over the op's retraction. A miss is a silent no-op: the record may have been
  // curated or nav-cleared since the event drained, which is not an error worth surfacing.
  async function retractRevertedEdit(tabId: number, event: MutationEvent): Promise<void> {
    const persister = createSessionChangesetPersister(tabId);
    const { changeset } = await applyChangesetOp(
      {
        load: persister.load,
        save: persister.save,
        // Best-effort mirror, same as the curation RPCs: a tab with no live session (evicted)
        // must not fail the retraction — the persister is the source of truth.
        mirror: (cs) =>
          sessions
            .setChangeset(tabId, cs)
            .then(() => undefined)
            .catch(() => undefined),
      },
      { kind: 'retract', event },
    );
    // Stamp the tab so a panel showing ANOTHER tab's record drops the push (same rule as the
    // curation RPCs, #141 review).
    if (changeset) postToPanel({ type: 'changeset', changeset, tabId });
    // Mid-turn: the running turn's in-memory store predates the op's retraction, and its next
    // persist would resurrect the phantom. Retract the same event there too (the SAME shared
    // matcher — never a divergent match+strip copy), then persist so both mirrors agree. Scoped
    // to the turn's OWN tab — a revert from another tab must never touch this store (selector
    // values can coincide across tabs).
    if (turnAbort !== null && turnChangeset !== null && turnChangeset.tabId === tabId) {
      const result = retractFromEdits(turnChangeset.store.current.edits, event);
      if (result !== null) {
        if (result.edits.length < turnChangeset.store.current.edits.length) {
          turnChangeset.store.removeAt(result.changedIndex, { preserveRedo: true });
        } else {
          const stripped = result.edits[result.changedIndex];
          if (stripped)
            turnChangeset.store.replaceAt(result.changedIndex, stripped, { preserveRedo: true });
        }
        await turnChangeset.persist();
      }
    }
  }

  // Content -> SW push (fire-and-forget forwarding to the panel; no response).
  chrome.runtime.onMessage.addListener((raw, sender) => {
    const parsed = ContentToSw.safeParse(raw);
    if (!parsed.success) return; // PanelToSw RPC handled by the listener above

    // #9: buffer recorder events per sender tab so the turn's `recordEdit` can fold the real
    // mechanical deltas into the durable Edit (and turn-end can auto-finalize leftovers).
    // relayToPanel still returns null for this type — nothing goes to the panel from here.
    if (parsed.data.type === 'recorder-event') {
      const senderTabId = sender.tab?.id;
      if (senderTabId !== undefined) pendingMutations.append(senderTabId, parsed.data.event);
    }

    // #9 undo phantom: the content recorder REVERTED a mutation (successful `undo()`) — its
    // buffered event must leave the pending buffer, else the turn-end auto-finalize (or a
    // later recordEdit) would fold a change that no longer exists on the page into the
    // durable changeset. When the buffer remove MISSES, the event already left the buffer
    // (drained by recordEdit / auto-finalized) — the phantom now lives in the DURABLE record
    // and must be retracted from there (#9 review round 2).
    if (parsed.data.type === 'recorder-revert') {
      const senderTabId = sender.tab?.id;
      if (senderTabId !== undefined && !pendingMutations.remove(senderTabId, parsed.data.event)) {
        void retractRevertedEdit(senderTabId, parsed.data.event).catch((err) =>
          console.warn(
            `[recorder-revert] failed to retract the reverted edit for tab ${senderTabId}:`,
            err,
          ),
        );
      }
    }

    // Pure mapping lives in src/shared/relay.ts (testable; entrypoints are
    // coverage-excluded). null = the event carries nothing to forward.
    const out = relayToPanel(parsed.data);
    if (out) postToPanel(out);
  });

  // Nav-clear (#9): a main-frame commit ends the tab's design-session record — the live edits
  // were ephemeral (they died with the old document), so the durable record must not ship edits
  // for a page that no longer exists. Wipe the recorder buffer + BOTH changeset mirrors: the
  // undo/redo persister (`changeset:<tabId>`) AND the SessionStore resume snapshot (turn start
  // falls back to it when no persister record exists). The mirror is re-seeded EMPTY for the new
  // URL, KEEPING the session's conversation id (#168 L6): the session — thread, usage — survives
  // the nav, and history is keyed by that id, so minting a fresh one forked the history
  // conversation per nav (and could evict an older one). Safe to keep — it is NOT an idempotency
  // key (#165 S10). Only edits are wiped. `webNavigation` is already a manifest
  // permission (frame enumeration, slice 13), so this needs no new grant. Iframe commits
  // (frameId !== 0) never clear the tab's record. A RELOAD is not a navigation away: the page
  // is the same URL, so per docs/architecture/changeset.md the live edits die but the recorded
  // changeset (and the recorder buffer) survive.
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    const { tabId, url } = details;
    // Stamp BEFORE the reload early-return: this listener is the document-identity authority
    // the turn-start URL guard compares against (all transitionTypes, reload included — a
    // reload re-commits the same document). Same-document navigations (hash, pushState) never
    // reach here, so a stale stamp can't survive one. The stamp is ALSO mirrored to
    // chrome.storage.session so the guard survives an SW eviction (#9 review round 4) —
    // fire-and-forget: the in-memory stamp already serves this worker's lifetime, and a
    // rejected write only degrades the post-eviction guard to the pre-fix fallback.
    lastCommittedUrl.set(tabId, url);
    void chrome.storage.session
      .set({ [committedUrlKey(tabId)]: url })
      .catch((err) =>
        console.warn(`[nav-clear] failed to persist the committed URL for tab ${tabId}:`, err),
      );
    if (details.transitionType === 'reload') return;
    pendingMutations.clear(tabId);
    void sessionsReady
      .then(async () => {
        // Race re-check (#9 review round 4): this wipe is deferred, and a turn that started
        // after the commit may have ALREADY re-seeded the persister for this NEW URL (its
        // turn-start URL guard saw the fresh stamp). Clearing now would wipe that live record
        // and resurrect the race it closed — skip the clear + reseed + push entirely.
        const persister = createSessionChangesetPersister(tabId);
        const current = await persister.load();
        if (current?.changeset.url === url) return;
        await persister.clear();
        const live = sessions.get(tabId);
        if (!live) return;
        // Keep the conversation id across the reseed (#168 L6, see the listener comment above).
        const reseeded = emptyChangeset(url, new Date().toISOString(), live.changeset.sessionId);
        await sessions.setChangeset(tabId, reseeded);
        // Tell an open Diff tab the record was wiped — otherwise it shows the dead page's
        // edits until its next refresh.
        postToPanel({ type: 'changeset', changeset: reseeded, tabId });
      })
      .catch((err) =>
        console.warn(`[nav-clear] failed to wipe the changeset record for tab ${tabId}:`, err),
      );
  });

  // Chrome detached the debugger without us asking (#165 S4): the user clicked Cancel on the
  // "started debugging this browser" infobar, DevTools opened on the tab, or the target crashed.
  // `applyCdp` is idempotent against the REGISTRY, so a stale `attached` record makes it skip the
  // re-attach; `sendCommand` then rejects "Debugger is not attached", `applyDevice` swallows that
  // and silently drops to the window-resize fallback — every later breakpoint measured with the
  // desktop UA, DPR 1 and no touch, while the model reports "responsive looks fine" from a desktop
  // rendering it believes is a Pixel 7. Clearing the record here lets the next `applyCdp` re-attach.
  // Guarded on API presence, like the `chrome.sidePanel` block above: `chrome.debugger` is absent
  // without the permission (and on Firefox), where the property access would throw synchronously.
  if (typeof chrome.debugger !== 'undefined') {
    chrome.debugger.onDetach.addListener(({ tabId }) => {
      if (tabId === undefined) return;
      void emulation
        .clearAttach(tabId)
        .catch((err) =>
          console.warn(`[emulation] failed to clear the detach record for tab ${tabId}:`, err),
        );
    });
  }

  // Tab-close cleanup: a closed tab's buffered recorder events can never fold (no turn will
  // drain them again) — drop the buffer so a recycled tab id never inherits stale mutations.
  // Same for the document-identity stamp (both copies): a recycled id must not compare against
  // the dead tab's committed URL.
  chrome.tabs.onRemoved.addListener((tabId) => {
    pendingMutations.clear(tabId);
    lastCommittedUrl.delete(tabId);
    void chrome.storage.session.remove(committedUrlKey(tabId)).catch(() => {});
  });

  // Screenshot capture (content -> SW, request/response). Only the SW has `tabs` capture; the
  // content script computes the crop rect and asks here. Capture the visible tab, crop to the
  // rect, and reply with a base64 PNG data URL. Any failure degrades to an error CaptureResult
  // the content script surfaces as an error ToolResult (the agent can retry / fall back to a11y).
  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const parsed = CaptureRequest.safeParse(raw);
    if (!parsed.success) return; // not a capture request
    const senderTabId = sender.tab?.id;
    // #165 S1, the content-initiated leg: the requesting frame computed its crop rect against ITS
    // page, but `captureVisibleTab` would return the window's ACTIVE tab. Refuse rather than crop
    // one page's geometry out of another's pixels. Re-probed (not read off `sender.tab.active`,
    // a snapshot from send time) so a tab switch during the round-trip is caught.
    (senderTabId === undefined
      ? Promise.resolve<string | null>(null)
      : captureBlockedReason(probeTab, senderTabId)
    )
      .then(async (blocked) => {
        if (blocked) return { ok: false, error: blocked } satisfies CaptureResult;
        return {
          ok: true,
          dataUrl: await captureVisibleTab(parsed.data, sender.tab?.windowId),
        } satisfies CaptureResult;
      })
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) } satisfies CaptureResult));
    return true; // async response
  });
});

// --- #168 turn attribution + thread view (pure; mirrored 1:1 by
// test/integration/thread-memory.test.ts — background.ts itself can't be imported under Vitest,
// see history-flow.test.ts's header note) --------------------------------------------------------

/** Is the configured provider endpoint OpenRouter? Gates the `cache_control` annotations
 *  (prompt-cache.ts): OpenRouter forwards them to Anthropic models; a strict OpenAI-compatible
 *  endpoint may reject the unknown field. Hostname match, not string equality, so a baseURL
 *  saved with/without a trailing slash (or an alternate path) still opts in. */
function isOpenRouterBase(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === 'openrouter.ai';
  } catch {
    return false;
  }
}

/** Annotate the last message of the PRIOR thread (everything before the just-appended user
 *  message) with a cache breakpoint — the placement prompt-cache.ts's doctrine prescribes: the
 *  breakpoint caches the whole prior conversation, and the new user message plus this turn's
 *  streamed steps grow past it without invalidating it. Pure copy; with no prior thread (first
 *  turn: `[user]`) there is nothing worth a breakpoint and the messages pass through untouched. */
function annotatePriorThreadTail(messages: readonly ChatMessage[]): ChatMessage[] {
  if (messages.length < 2) return [...messages];
  const tail = messages.length - 2;
  return messages.map((m, i) => (i === tail ? withCacheBreakpoint(m) : m));
}

/** Stamp `turnId` onto the five per-turn stream events (`token`/`tool-call`/`tool-result`/
 *  `error`/`turn-done`); every other push passes through untouched. */
function stampTurnId(update: SwToPanel, turnId: string): SwToPanel {
  switch (update.type) {
    case 'token':
    case 'tool-call':
    case 'tool-result':
    case 'error':
    case 'turn-done':
      return { ...update, turnId };
    default:
      return update;
  }
}

/** Per-turn tool chip being assembled by {@link toThreadView}: the `toolCallId` correlates a
 *  later tool-result to its call, exactly like the stream's `tool-call`/`tool-result` pairing. */
interface ThreadViewTool {
  name: string;
  ok: boolean;
  id?: string;
}

/** The visible text of a message's content: the string itself, or its `text` parts joined —
 *  never images/tool payloads. Structural narrowing (the content unions differ per role). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const part of content) {
    if (
      part !== null &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string' &&
      part.text.length > 0
    ) {
      texts.push(part.text);
    }
  }
  return texts.join('\n\n');
}

/** Did this tool-result output report success? `error-text`/`error-json`/`execution-denied`
 *  outputs are failures; a JSON output carrying the content-bus `ToolResult` shape answers with
 *  its own `ok`; anything else (plain text, unrecognized) counts as success — same optimism as
 *  the panel folding a result chip without an `error`. */
function toolOutputOk(output: unknown): boolean {
  if (output === null || typeof output !== 'object') return true;
  const type = 'type' in output ? output.type : undefined;
  if (type === 'error-text' || type === 'error-json' || type === 'execution-denied') return false;
  const value = 'value' in output ? output.value : output;
  if (
    value !== null &&
    typeof value === 'object' &&
    'ok' in value &&
    typeof value.ok === 'boolean'
  ) {
    return value.ok;
  }
  return true;
}

/** Fold one tool-result part onto the pending chip it answers (by `toolCallId`, else the newest
 *  same-named chip), or append a chip of its own when the call fell outside the thread. */
function settleThreadTool(
  tools: ThreadViewTool[],
  part: { toolCallId?: string; toolName: string; output?: unknown },
): void {
  const ok = toolOutputOk(part.output);
  const byId = part.toolCallId ? tools.find((t) => t.id === part.toolCallId) : undefined;
  const target = byId ?? [...tools].reverse().find((t) => t.name === part.toolName);
  if (target) target.ok = ok;
  else tools.push({ name: part.toolName, ok });
}

/**
 * Render the SW's persisted session thread down to the panel-facing view (#168 C): one entry per
 * user message, and ONE assistant entry per turn — consecutive assistant/tool messages between
 * user messages fold together (their prose joined, their tool calls settled in order by the
 * matching tool-results). Raw provider parts (tool payloads, images) never cross the bus. A
 * tool-call with no persisted result keeps `ok: true` — the absence of a recorded failure, same
 * as a text-only output. System messages are the SW's own scaffolding and are dropped. Bounded to
 * the same caps the schema enforces (`HISTORY_MAX_MESSAGES` messages, 100 tools per entry).
 */
function toThreadView(messages: readonly ChatMessage[]): ThreadViewMessage[] {
  const view: ThreadViewMessage[] = [];
  let turn: { texts: string[]; tools: ThreadViewTool[] } | null = null;

  const flushTurn = (): void => {
    if (!turn) return;
    const tools = turn.tools.slice(0, 100).map(({ name, ok }) => ({ name, ok }));
    view.push({
      role: 'assistant',
      text: turn.texts.filter((t) => t.length > 0).join('\n\n'),
      ...(tools.length > 0 ? { tools } : {}),
    });
    turn = null;
  };

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      flushTurn();
      view.push({ role: 'user', text: contentText(message.content) });
      continue;
    }
    if (message.role === 'assistant') {
      turn ??= { texts: [], tools: [] };
      if (typeof message.content === 'string') {
        if (message.content.length > 0) turn.texts.push(message.content);
        continue;
      }
      for (const part of message.content) {
        if (part.type === 'text') {
          if (part.text.length > 0) turn.texts.push(part.text);
        } else if (part.type === 'tool-call') {
          turn.tools.push({ name: part.toolName, ok: true, id: part.toolCallId });
        } else if (part.type === 'tool-result') {
          // Provider-executed tools settle inline in the assistant message.
          settleThreadTool(turn.tools, part);
        }
      }
      continue;
    }
    // role === 'tool': results answering the current turn's calls. An orphaned tool message
    // (no assistant before it — a truncated thread) still surfaces as chips on a text-less turn.
    turn ??= { texts: [], tools: [] };
    for (const part of message.content) {
      if (part.type === 'tool-result') settleThreadTool(turn.tools, part);
    }
  }
  flushTurn();
  return view.slice(-HISTORY_MAX_MESSAGES);
}

// `chrome.tabs.get` as the capture guard's tab probe (`src/agent/capture-target.ts`). A raw tabs
// read — never a content dispatch — so guarding inside a lock holder can't self-deadlock.
const probeTab: CaptureTargetProbe = (tabId) => chrome.tabs.get(tabId);

// Grab the visible tab as PNG, re-wording the one failure the user can actually act on. Chrome
// answers a capture without page access with "Either the '<all_urls>' or 'activeTab' permission is
// required." — accurate, and useless to someone who has never heard of either. The readiness
// panel's "Page access" row is where this is fixed, so the error says so.
async function grabVisibleTab(windowId?: number): Promise<string> {
  try {
    return await chrome.tabs.captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
      format: 'png',
    });
  } catch (err) {
    const message = String(err);
    if (/permission is required|activeTab|all_urls/i.test(message)) {
      throw new Error(
        'Cannot screenshot this page: the extension has no page access. Open the status ' +
          'dropdown in the panel header and Grant it on the "Page access" row, then retry. ' +
          'DOM reads and edits still work meanwhile — prefer `describe` / `getStyles`.',
      );
    }
    throw err;
  }
}

// Capture the visible tab as PNG, then crop to the requested (page-CSS-px) rect. `windowId` comes
// from the requesting content script's tab; falls back to the current window.
async function captureVisibleTab(req: CaptureRequest, windowId?: number): Promise<string> {
  const full = await grabVisibleTab(windowId);
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
// Which tabs have the debugger attached + which windows we've resized is tracked in the persisted
// `emulation` registry (survives SW eviction) rather than a bare in-memory Set/Map, and keyed by the
// owning turn so attach stays idempotent, restore returns each window to its pre-emulation bounds,
// and a woken SW can reconcile emulation orphaned by an eviction (see `emulationReady`).
//
// Only the raw chrome calls live here; the bookkeeping (owner stamping, idempotent attach, saved
// bounds) is `src/agent/device-driver.ts`, which is unit-tested.
const deviceChrome: DeviceChrome = {
  // `chrome.debugger` exists only when the `debugger` permission is declared + granted; otherwise the
  // runner takes the viewport fallback.
  cdpAvailable: () => typeof chrome.debugger !== 'undefined',
  attach: (tabId) => chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION),
  detach: (tabId) => chrome.debugger.detach({ tabId }),
  sendCommand: async (tabId, method, params) => {
    await chrome.debugger.sendCommand({ tabId }, method, params);
  },
  windowIdOf: async (tabId) => (await chrome.tabs.get(tabId)).windowId,
  windowBounds: async (windowId) => {
    const win = await chrome.windows.get(windowId);
    return { width: win.width, height: win.height };
  },
  resizeWindow: async (windowId, size) => {
    await chrome.windows.update(windowId, { state: 'normal', ...size });
  },
  restoreWindow: async (saved) => {
    await chrome.windows.update(saved.windowId, { width: saved.width, height: saved.height });
  },
  defaultUserAgent: () => navigator.userAgent,
};

/** This turn's emulation driver. `owner` is captured in the closure, so no await inside the driver
 *  can observe a newer turn's id — the #165 S3 fix. */
const deviceDriverFor = (owner: string) => createDeviceDriver(deviceChrome, emulation, owner);

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
      frames.push(await grabVisibleTab(windowId));
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
