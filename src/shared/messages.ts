import { modelMessageSchema } from 'ai';
import { z } from 'zod';
import { Changeset, Edit, StableSelector } from './changeset';
import { CollectorSignal } from './diagnostics';

// StableSelector lives in changeset.ts but is part of the message vocabulary; re-export
// it so panel/content consumers import the selector type from the message-schema hub.
// Likewise for CollectorSignal (src/shared/diagnostics.ts): the debug engine's domain shapes
// live there, but DomTool/ContentToSw below need it as part of the bus transport.
export { CollectorSignal, StableSelector };

// The two headline agent activities (plan 06 `agent/modes.ts`). Optional on `UserMessage`: an
// explicit choice (e.g. a composer affordance) wins; when absent, `agent/modes.ts` `resolveMode`
// infers it from the instruction text so a bare "debug my checkout flow" still gets the right
// prompt addendum + tool emphasis with no forced UI step.
export const Mode = z.enum(['copy', 'debug']);
export type Mode = z.infer<typeof Mode>;

// Typed message bus across the three MV3 worlds: panel <-> service worker <-> content.
// Every payload is Zod-validated at the boundary. See docs/architecture/mv3-worlds.md.

// --- shared bus primitives -----------------------------------------------
// Serialized DOMRect subset the picker overlay needs to draw a highlight.
export const Rect = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Rect = z.infer<typeof Rect>;

// --- panel -> service worker ---------------------------------------------
export const UserMessage = z.object({
  type: z.literal('user-message'),
  text: z.string(),
  // Explicit copy/debug choice, when the composer offers one (see 06/11). Absent ⇒
  // `agent/modes.ts` `resolveMode` infers it from `text`.
  mode: Mode.optional(),
});

// User-triggered Ship (slice 07) — hand the accepted design session to a connected coding backend,
// or fall back to a downloadable brief. NEVER auto-ships: only the panel's Ship button / a chat
// command emits this (docs/idea/principles.md). The SW routes it (`src/mcp/backend.ts`
// `routeHandoff`): a connected backend exposing a `task` tool + a repo mapped to this page's origin
// ⇒ dispatch `task(create)` (one per `problems[]` entry when decomposed, else a single task);
// otherwise the agent-authored Markdown brief comes back for download.
export const ShipRequest = z.object({
  type: z.literal('ship'),
  // Which produced artifact to hand off. 'report' (default) runs the summarization pass and ships
  // the brief; 'changeset' hands off the raw recorded edits.
  source: z.enum(['changeset', 'report']).default('report'),
  // Named coding backend to dispatch through — an MCP connection id or its label. Omitted ⇒ the SW
  // picks the first connected backend that exposes a `task` tool. The repo (origin→repo map) is what
  // actually routes; an unmapped origin falls back to a downloadable report.
  target: z.string().optional(),
  // Copy/debug framing for the report pass (slice 06). Absent ⇒ a neutral review.
  mode: Mode.optional(),
  // Non-empty ⇒ decompose the handoff into one `task(create)` per problem (multi-task fan-out);
  // absent/empty ⇒ a single task carrying the whole brief.
  problems: z.array(z.string().max(600)).max(40).optional(),
  // Optional headline override for a single-task ship.
  title: z.string().max(300).optional(),
});
export type ShipRequest = z.infer<typeof ShipRequest>;

// Panel "Download report" / chat "make a report" (slice 07): run the agent summarization pass and
// return the Markdown brief for the panel to save via a blob URL (own origin, CSP-clean). Never
// dispatches — download is always available, even with no backend connected.
export const DownloadReport = z.object({
  type: z.literal('download-report'),
  mode: Mode.optional(),
});

// Chat "send this to <backend>" (slice 07): author the brief and dispatch it to the named backend as
// `task(create)`, streaming `task-status`. Falls back to a downloadable brief when `target` isn't a
// connected backend or the origin has no repo mapped. `target` names the backend (id or label).
export const SendReport = z.object({
  type: z.literal('send-report'),
  target: z.string().min(1),
  mode: Mode.optional(),
  problems: z.array(z.string().max(600)).max(40).optional(),
});

// Settings / BYOK (panel -> service worker). The OpenRouter key is entered in the
// panel, but custody + crypto + network are SW-only: the plaintext key crosses
// panel->SW only (both are the trusted extension origin), NEVER panel->content.
// See CLAUDE.md "MV3 three worlds" + docs/architecture/security.md.
// An openai-compatible endpoint the agent talks to (OpenRouter, OpenAI, a local
// llama.cpp server, ...). `apiKey` is write-only across the bus: `save-provider` carries
// it panel->SW once; `get-provider` never echoes it back (see `GetProviderResult` —
// `hasKey` signals presence only). `src/agent/config-store.ts` is the SW-side persistence
// for this same shape; it imports the type from here rather than redefining it.
export const ProviderConfig = z.object({
  baseURL: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  label: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const SaveProvider = z.object({
  type: z.literal('save-provider'),
  config: ProviderConfig,
});
export const GetProvider = z.object({ type: z.literal('get-provider') });

// Legacy alias predating ProviderConfig: a bare OpenRouter key with no baseURL/model
// choice. Kept for back-compat; the SW maps it onto ProviderConfig with the OpenRouter
// preset baseURL against the existing selected model.
export const SaveKey = z.object({
  type: z.literal('save-openrouter-key'),
  text: z.string().min(1),
});
// baseURL-aware: omitted -> SW lists models for the currently saved provider config
// (back-compat with the OpenRouter-only caller); present -> lists models for that
// not-yet-saved endpoint so the panel can populate the model dropdown before Save.
export const ListModels = z.object({
  type: z.literal('list-models'),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
});
export const SetModel = z.object({ type: z.literal('set-model'), model: z.string().min(1) });
export const KeyStatus = z.object({ type: z.literal('key-status') });
export const ClearKey = z.object({ type: z.literal('clear-openrouter-key') });

// User-driven element picker (panel button -> SW -> forwarded as a PickerCmd to
// content). Distinct from the agent's DomTool calls; the picker is never agent-run.
export const StartPicker = z.object({ type: z.literal('start-picker') });
export const StopPicker = z.object({ type: z.literal('stop-picker') });

// --- MCP servers (panel <-> service worker) -------------------------------
// Server management + auth: docs/idea/mcp.md. Mirrors the non-secret shape persisted by
// `src/mcp/store.ts` (`StoredServer`/`AuthKind`) — duplicated here rather than imported,
// since that module (and `src/mcp/auth.ts`) is SW-only (chrome.identity, key-store
// decrypt) and this file is shared with content.ts. The credential itself (API key /
// OAuth token) never lives in these schemas except as a one-time write in `McpAuthStart`.
export const McpTransport = z.enum(['http']);
export type McpTransport = z.infer<typeof McpTransport>;

export const AuthKind = z.enum(['none', 'apikey', 'oauth']);
export type AuthKind = z.infer<typeof AuthKind>;

export const McpConnectionStatus = z.enum(['disconnected', 'connected', 'error']);
export type McpConnectionStatus = z.infer<typeof McpConnectionStatus>;

// OAuth endpoints + public client id for one backend (mirrors `src/mcp/auth.ts`'s
// `OAuthConfig`). Non-secret — supplied by the Add-server/AuthDialog form or a preset.
export const McpOAuthConfig = z.object({
  authorizationEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
  clientId: z.string().min(1),
  scope: z.string().optional(),
});
export type McpOAuthConfig = z.infer<typeof McpOAuthConfig>;

// A configured server as the panel sees it: `mcp/store.ts`'s persisted record merged
// with `mcp/manager.ts`'s live connection health. `toolCount`/`tools` are 0/[] until a
// successful connect; `error` is set only when `status === 'error'`.
export const McpServer = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  url: z.string().url(),
  transport: McpTransport,
  authKind: AuthKind,
  status: McpConnectionStatus,
  toolCount: z.number().int().nonnegative(),
  tools: z.array(z.string()),
  error: z.string().optional(),
});
export type McpServer = z.infer<typeof McpServer>;

export const McpAdd = z.object({
  type: z.literal('mcp-add'),
  label: z.string().min(1),
  url: z.string().url(),
  transport: McpTransport.optional(),
  authKind: AuthKind.optional(),
});
export const McpRemove = z.object({ type: z.literal('mcp-remove'), id: z.string().min(1) });
export const McpList = z.object({ type: z.literal('mcp-list') });
export const McpConnect = z.object({ type: z.literal('mcp-connect'), id: z.string().min(1) });

// Submits the credential for a server's chosen auth kind — one RPC for both `AuthDialog`
// paths: an API key (stored as-is, Bearer at connect time) or an OAuth PKCE flow the SW
// drives end-to-end via `chrome.identity.launchWebAuthFlow` (`src/mcp/auth.ts`
// `startOAuth`) before returning. `authKind` is the discriminant so each variant carries
// exactly the credential shape it needs.
export const McpAuthStart = z.discriminatedUnion('authKind', [
  z.object({
    type: z.literal('mcp-auth-start'),
    id: z.string().min(1),
    authKind: z.literal('apikey'),
    apiKey: z.string().min(1),
  }),
  z.object({
    type: z.literal('mcp-auth-start'),
    id: z.string().min(1),
    authKind: z.literal('oauth'),
    oauth: McpOAuthConfig,
  }),
]);
export type McpAuthStart = z.infer<typeof McpAuthStart>;

// Ask the SW to (re)publish current health for every registered server on the
// `mcp-status` stream — e.g. when a panel (re)connects and has no cached state yet.
export const McpStatusRequest = z.object({ type: z.literal('mcp-status') });

// --- history: last-10 conversations + reports (slice 08) ------------------
// Persisted history of the agent's last 10 conversations (`src/agent/history-store.ts`, SW-only —
// touches `chrome.storage.local`; the panel never touches storage directly, only these RPCs).
// `Conversation` + its bound consts live HERE (the message-vocabulary hub), not in history-store.ts,
// so history-store.ts can import them without a messages.ts -> history-store.ts -> messages.ts cycle
// (history-store needs `Mode`, defined above in this same file). `messages`/`report` are re-bounded
// on write (history-store's `boundMessages`/`MAX_REPORT_CHARS` slice) — the schema caps below mirror
// those write-time bounds so a corrupt/oversized persisted record is rejected on `hydrate()` rather
// than trusted.
export const HISTORY_MAX_TITLE_CHARS = 200;
export const HISTORY_MAX_REPORT_CHARS = 20_000;
export const HISTORY_MAX_MESSAGES = 200;

// One persisted conversation: the turn thread + whatever the session produced (a handoff report,
// the PR it became). `messages`/`report` are bounded on write by `history-store.ts`'s
// `boundMessages`/slice — never trust an unbounded value coming back from storage either, hence
// the schema caps too.
export const Conversation = z.object({
  id: z.string().min(1),
  title: z.string().max(HISTORY_MAX_TITLE_CHARS),
  url: z.string(),
  mode: Mode.optional(),
  createdAt: z.number(),
  messages: z.array(modelMessageSchema).max(HISTORY_MAX_MESSAGES).default([]),
  // The handoff brief (07), already rendered to Markdown — never the raw `Report` object or any
  // embedded images; keeps a history entry cheap to list and safe to store.
  report: z.string().max(HISTORY_MAX_REPORT_CHARS).optional(),
  // The PR the ship flow (12) opened from this conversation's changeset.
  prLink: z.string().max(2048).optional(),
});
export type Conversation = z.infer<typeof Conversation>;

// A history-list row: everything but the heavy fields, plus counts the panel can render without
// pulling the full thread over the bus (`history-list` vs `history-get(id)` below).
export const ConversationSummary = Conversation.omit({ messages: true, report: true }).extend({
  messageCount: z.number().int().nonnegative(),
  hasReport: z.boolean(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

// List every persisted conversation as lightweight summaries (no thread/report payload).
export const HistoryList = z.object({ type: z.literal('history-list') });
// Fetch one conversation's full record (thread + report/PR link) for a read-only replay.
export const HistoryGet = z.object({ type: z.literal('history-get'), id: z.string().min(1) });
// Remove a conversation from history. No-op server-side for an unknown id.
export const HistoryDelete = z.object({
  type: z.literal('history-delete'),
  id: z.string().min(1),
});

// --- readiness + session (slice 03) ---------------------------------------
// Header status-pill truth: whether the agent can run at all. `ready` gates chat entry
// and is `provider && model` only — MCP is optional (copy/debug flows still work without
// a connected backend, see 06/07). Computed SW-side in `src/agent/readiness.ts` from the
// config-store (01), the live `McpManager` (02), and the runtime host-permission grant.
export const ReadinessState = z.object({
  provider: z.enum(['ok', 'missing']),
  model: z.enum(['ok', 'missing']),
  hostPermission: z.enum(['granted', 'needed']),
  mcp: z.object({
    connected: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  ready: z.boolean(),
});
export type ReadinessState = z.infer<typeof ReadinessState>;

export const Readiness = z.object({ type: z.literal('readiness') });

// Start/Stop toggle. Start is only actionable once `ReadinessState.ready`; while a turn
// runs the panel shows Stop, which aborts the in-flight agent turn (04) without ending the
// session. Ending the session (toggling off) returns the panel to the pre-Start state.
export const SessionStart = z.object({ type: z.literal('session-start') });
export const SessionStop = z.object({ type: z.literal('session-stop') });

export const PanelToSw = z.discriminatedUnion('type', [
  UserMessage,
  ShipRequest,
  DownloadReport,
  SendReport,
  SaveProvider,
  GetProvider,
  SaveKey,
  ListModels,
  SetModel,
  KeyStatus,
  ClearKey,
  StartPicker,
  StopPicker,
  McpAdd,
  McpRemove,
  McpList,
  McpConnect,
  McpAuthStart,
  McpStatusRequest,
  Readiness,
  SessionStart,
  SessionStop,
  HistoryList,
  HistoryGet,
  HistoryDelete,
]);
export type PanelToSw = z.infer<typeof PanelToSw>;

// --- service worker -> panel RPC responses (sendResponse replies, NOT the
// SwToPanel stream). None of these ever carries the key value.
export const OkResult = z.object({ ok: z.boolean(), error: z.string().optional() });
export type OkResult = z.infer<typeof OkResult>;

export const SaveKeyResult = z.object({
  ok: z.boolean(),
  valid: z.boolean(),
  error: z.string().optional(),
});
export type SaveKeyResult = z.infer<typeof SaveKeyResult>;

export const KeyStatusResult = z.object({
  ok: z.boolean(),
  present: z.boolean(),
  model: z.string().optional(),
});
export type KeyStatusResult = z.infer<typeof KeyStatusResult>;

export const SaveProviderResult = z.object({
  ok: z.boolean(),
  valid: z.boolean(),
  error: z.string().optional(),
});
export type SaveProviderResult = z.infer<typeof SaveProviderResult>;

// `config` omits `apiKey` (write-only across the bus, see ProviderConfig above);
// `hasKey` lets the panel render its key field as a presence-only placeholder.
export const GetProviderResult = z.object({
  ok: z.boolean(),
  config: ProviderConfig.omit({ apiKey: true }).optional(),
  hasKey: z.boolean().optional(),
});
export type GetProviderResult = z.infer<typeof GetProviderResult>;

export const ModelOption = z.object({ id: z.string(), name: z.string() });
export type ModelOption = z.infer<typeof ModelOption>;

export const ModelsResult = z.object({
  ok: z.boolean(),
  models: z.array(ModelOption).optional(),
  error: z.string().optional(),
});
export type ModelsResult = z.infer<typeof ModelsResult>;

// RPC responses for mcp-add / mcp-connect / mcp-auth-start (one server) and mcp-list
// (the full set). mcp-remove / mcp-status(request) reply with the plain `OkResult`.
export const McpServerResult = z.object({
  ok: z.boolean(),
  server: McpServer.optional(),
  error: z.string().optional(),
});
export type McpServerResult = z.infer<typeof McpServerResult>;

export const McpListResult = z.object({
  ok: z.boolean(),
  servers: z.array(McpServer).optional(),
  error: z.string().optional(),
});
export type McpListResult = z.infer<typeof McpListResult>;

// RPC response for `readiness`. Compute never throws (see `src/agent/readiness.ts`), so
// `ok` is always true here; the field is kept for the bus's shared response shape.
export const ReadinessResult = z.object({ ok: z.boolean(), state: ReadinessState });
export type ReadinessResult = z.infer<typeof ReadinessResult>;

// RPC response for `ship` / `send-report` / `download-report` (slice 07). `routed` says what
// happened: 'tasks' = dispatched to a connected backend (per-task progress then streams as
// `task-status`); 'report' = no backend/repo, so `markdown` (+ a suggested `filename`) is the
// agent-authored brief the panel saves via a blob URL. Only the rendered Markdown crosses the bus —
// not the full `Report` with its embedded base64 shots — so a screenshot-heavy brief can't bloat the
// reply. `reason` explains a fallback; `taskCount` is set on the tasks route.
export const HandoffResult = z.object({
  ok: z.boolean(),
  routed: z.enum(['tasks', 'report']).optional(),
  taskCount: z.number().int().nonnegative().optional(),
  markdown: z.string().optional(),
  filename: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});
export type HandoffResult = z.infer<typeof HandoffResult>;

// RPC responses for the history RPCs above. `history-delete` replies with the plain `OkResult`.
export const HistoryListResult = z.object({
  ok: z.boolean(),
  conversations: z.array(ConversationSummary).optional(),
});
export type HistoryListResult = z.infer<typeof HistoryListResult>;

export const HistoryGetResult = z.object({
  ok: z.boolean(),
  conversation: Conversation.optional(),
  error: z.string().optional(),
});
export type HistoryGetResult = z.infer<typeof HistoryGetResult>;

// --- service worker -> content (DOM tools) -------------------------------
// Shared frame/tab target carried by every DOM/control/vision tool (slice 13). `tabId` picks the
// tab (default: the turn's active tab); `frameId` picks an iframe within it (default: the top
// document). Content scripts run per-frame (`all_frames`), so the SW routes a tool to the right
// frame via `chrome.tabs.sendMessage(tabId, msg, { frameId })`, and a cross-origin child frame is
// addressed on its own injected script — never reached into from its parent. Both optional +
// backward-compatible: a call with neither field hits the active tab's top document, exactly as
// before frames/tabs existed (every pre-13 DomTool call still validates unchanged).
export const Target = z.object({
  tabId: z.number().int().nonnegative().optional(),
  frameId: z.number().int().nonnegative().optional(),
});
export type Target = z.infer<typeof Target>;

// One named input const per tool. The DomTool union is built FROM these, so #11
// can derive `tool({ inputSchema })` 1:1 with zero drift — add a tool = add a
// const + one union entry. The `type` literal is both the bus discriminant and
// the tool name #11 maps to. Every input spreads `Target.shape` for frame/tab addressing.
export const QueryInput = z.object({
  type: z.literal('query'),
  selector: z.string(),
  ...Target.shape,
});
export const GetStylesInput = z.object({
  type: z.literal('getStyles'),
  selector: z.string(),
  ...Target.shape,
});
export const ScreenshotInput = z.object({
  type: z.literal('screenshot'),
  selector: z.string().optional(),
  // Capture the whole scrollable page (the SW scroll-stitches viewport grabs), not just the
  // viewport. Ignored when `selector` is set — an element crop wins. Vision path: bound its use
  // (slice 13 budget guards) since a tall page yields many captures.
  fullPage: z.boolean().optional(),
  ...Target.shape,
});
export type ScreenshotInput = z.infer<typeof ScreenshotInput>;
export const SetStyleInput = z.object({
  type: z.literal('setStyle'),
  selector: z.string(),
  props: z.record(z.string(), z.string()),
  ...Target.shape,
});
export const SetTextInput = z.object({
  type: z.literal('setText'),
  selector: z.string(),
  value: z.string(),
  ...Target.shape,
});
export const A11ySnapshotInput = z.object({
  type: z.literal('a11ySnapshot'),
  selector: z.string(),
  ...Target.shape,
});
export const UndoInput = z.object({ type: z.literal('undo'), ...Target.shape });

// The debug engine's content-side pull (slice 06, complements the `diagnostics-signal` PUSH
// below): `drain` returns everything the collector has buffered since the last drain (runtime +
// network signals) and clears it; `scan` runs a fresh point-in-time a11y + layout scan. Neither
// targets a selector — both read the whole page — so, unlike the other DomTools, there's no
// `selector` field.
export const DiagnosticsInput = z.object({
  type: z.literal('diagnostics'),
  action: z.enum(['drain', 'scan']),
  ...Target.shape,
});
export type DiagnosticsInput = z.infer<typeof DiagnosticsInput>;

export const DomTool = z.discriminatedUnion('type', [
  QueryInput,
  GetStylesInput,
  ScreenshotInput,
  SetStyleInput,
  SetTextInput,
  A11ySnapshotInput,
  UndoInput,
  DiagnosticsInput,
]);
export type DomTool = z.infer<typeof DomTool>;

// The `diagnostics` DomTool's `ToolResult.data` shape — bounded the same way `CollectorSignal`'s
// own fields are (src/shared/diagnostics.ts), so a `drain`/`scan` round-trip can't blow the
// agent's token budget on a hostile or chatty page.
export const DiagnosticsToolResult = z.object({ signals: z.array(CollectorSignal).max(300) });
export type DiagnosticsToolResult = z.infer<typeof DiagnosticsToolResult>;

// Element-picker commands (SW -> content). Deliberately NOT part of DomTool: the
// picker is user-driven, so #11 wraps DomTool 1:1 as agent tools with no exclusions.
export const PickerCmd = z.discriminatedUnion('type', [
  z.object({ type: z.literal('picker-start') }),
  z.object({ type: z.literal('picker-stop') }),
]);
export type PickerCmd = z.infer<typeof PickerCmd>;

export const ToolResult = z.object({
  type: z.literal('tool-result'),
  ok: z.boolean(),
  selector: StableSelector.optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  // The frame the result came from (slice 13 iframes): query/screenshot/readImages tag their frame
  // so the SW can compose coordinates and re-address the same frame. Absent = the top document.
  frameId: z.number().int().nonnegative().optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

// Typed shapes for `ToolResult.data` per read tool. `data` itself stays `unknown`
// (the envelope); a consumer parses it with the matching schema once it knows the
// tool it called. #11 pairs each with its input const.
export const QueryResult = z.object({
  // The winning stable selector per matched element (uniqueness resolved in content).
  matches: z.array(StableSelector),
});
export type QueryResult = z.infer<typeof QueryResult>;

export const GetStylesResult = z.object({
  // The changed / relevant subset of computed styles, prop -> value.
  styles: z.record(z.string(), z.string()),
});
export type GetStylesResult = z.infer<typeof GetStylesResult>;

// Accessibility role/name tree (cheaper than a screenshot for the agent to read).
// `children` defaults to `[]`: a leaf is the common case, and every real producer of
// an a11y tree (Chrome's AX API, ARIA serializers) omits the key on leaves rather than
// emitting an empty array. Requiring it would reject a well-formed snapshot outright.
export const A11yNode = z.object({
  role: z.string(),
  name: z.string(),
  get children() {
    return z.array(A11yNode).default([]);
  },
});
export type A11yNode = z.infer<typeof A11yNode>;

export const A11yResult = z.object({ tree: A11yNode });
export type A11yResult = z.infer<typeof A11yResult>;

// --- browser control: interaction tools (content-routed, slice 13) --------
// The agent drives the page like a user — click / type / press / hover / scroll / select, plus a
// bounded `waitFor`, native-dialog handling, and `readImages` to see what's on screen. Each runs
// in the content script of the target frame (so each spreads `Target`) and rides its own input
// const. Kept OUT of `DomTool` on purpose: that union stays 1:1 with `createDomTools`
// (`src/agent/tools/dom.ts`) — the slice-05 read/mutate primitives — whereas these slice-13
// driving tools derive in `src/agent/tools/interact.ts` and route through `content.ts` beside
// DomTool. Driving the page (navigation, form entry) is an ACTION, not a recorder mutation: the
// report flags it as such and it is not reversible via `undo`.
export const ClickInput = z.object({
  type: z.literal('click'),
  selector: z.string(),
  ...Target.shape,
});
export const TypeInput = z.object({
  type: z.literal('type'),
  selector: z.string(),
  text: z.string(),
  // Press Enter after typing to submit the field/form. Default: fire input/change, keep focus.
  submit: z.boolean().optional(),
  ...Target.shape,
});
export const PressKeyInput = z.object({
  type: z.literal('pressKey'),
  // A single key or named key, e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown'.
  key: z.string().min(1),
  ...Target.shape,
});
export const HoverInput = z.object({
  type: z.literal('hover'),
  selector: z.string(),
  ...Target.shape,
});
// Scroll an element into view (`selector`) OR to an absolute page offset (`y`). Provide one — the
// content impl prefers `selector` when both are present; neither is a no-op (reads current pos).
export const ScrollToInput = z.object({
  type: z.literal('scrollTo'),
  selector: z.string().optional(),
  y: z.number().optional(),
  ...Target.shape,
});
export const SelectOptionInput = z.object({
  type: z.literal('selectOption'),
  selector: z.string(),
  // Choose the option by value (the impl falls back to matching the visible label) — a native
  // <select> or an ARIA listbox/combobox.
  value: z.string(),
  ...Target.shape,
});
// The condition `waitFor` blocks on: resolve as soon as `selector`/`text` appears, the network
// goes idle, the page hydrates (`hydrated` — SPA framework mounted + `document.readyState ===
// 'complete'`), or the DOM goes quiet after that (`quiescent` — hydrated AND no mutation for a
// settle window; slice 15A `waitForQuiescence`). Capped by `timeMs` (hard max 30s so a stuck page
// can't hang the turn — slice 13 guardrail). Given only `timeMs`, it is a plain bounded delay.
// Exported standalone for the tool wrapper (`src/agent/tools/interact.ts`) and the content impl
// (`src/dom/interact.ts`).
export const WaitCondition = z.object({
  selector: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  networkIdle: z.boolean().optional(),
  hydrated: z.boolean().optional(),
  quiescent: z.boolean().optional(),
  timeMs: z.number().int().positive().max(30_000).optional(),
});
export type WaitCondition = z.infer<typeof WaitCondition>;
export const WaitForInput = z.object({
  type: z.literal('waitFor'),
  ...WaitCondition.shape,
  ...Target.shape,
});
// Answer a native dialog the agent's OWN action triggered (confirm / alert / prompt / beforeunload):
// `accept` = OK vs Cancel, `promptText` fills a prompt(). Auto-answered only for agent-initiated
// actions (slice 13 step 5) — a dialog the user raised is never silently dismissed.
export const HandleDialogInput = z.object({
  type: z.literal('handleDialog'),
  accept: z.boolean(),
  promptText: z.string().optional(),
  ...Target.shape,
});
// Enumerate the images in the target subtree (`selector`) or the whole document — both `<img>` and
// CSS background-image. The content side resolves each to a stable selector + natural/rendered size
// and flags broken/oversized (a debug + copy signal). Result payload = `ReadImagesResult`.
export const ReadImagesInput = z.object({
  type: z.literal('readImages'),
  selector: z.string().optional(),
  ...Target.shape,
});
export type ReadImagesInput = z.infer<typeof ReadImagesInput>;

// `ControlTool` (the content-routed driving-tools union) is declared further below, once the
// complex-site inputs it also carries (`ReadChartInput`/`ChartTooltipInput`/`WidgetActInput`/
// `PageFactsInput`) exist — they reference `WidgetRecipe`/`ChartRead`/`PageFacts`, defined in the
// slice-15 section near the bottom of this file.

// One image the page renders — an `<img>` or a CSS background-image — resolved to a stable selector
// so the agent can act on it. `broken` = failed load (naturalWidth 0); `oversized` = intrinsic
// pixels far exceed the rendered box (wasted bytes / layout-shift risk). Sizes are content-measured;
// bounds cap a hostile or image-heavy page's payload (as DiagnosticsToolResult / DesignRead do).
export const ImageInfo = z.object({
  selector: StableSelector,
  kind: z.enum(['img', 'background']),
  src: z.string().max(2048),
  alt: z.string().max(500).optional(),
  naturalWidth: z.number().int().nonnegative(),
  naturalHeight: z.number().int().nonnegative(),
  renderedWidth: z.number().nonnegative(),
  renderedHeight: z.number().nonnegative(),
  broken: z.boolean(),
  oversized: z.boolean(),
});
export type ImageInfo = z.infer<typeof ImageInfo>;

// `readImages` payload (`ToolResult.data`): every enumerated image, bounded.
export const ReadImagesResult = z.object({ images: z.array(ImageInfo).max(200) });
export type ReadImagesResult = z.infer<typeof ReadImagesResult>;

// --- cross-site browse (agent tool, service-worker-orchestrated) ----------
// `browse(url)` is an agent tool like the DOM tools, but it is deliberately NOT a `DomTool`:
// a DomTool is routed to the *active* tab's content script, whereas browse opens its OWN
// inactive background tab, snapshots it, and closes it — never hijacking the user's page
// (`src/entrypoints/background.ts` `runBrowse`). So it rides its own input schema + tool
// module (`src/agent/tools/browse.ts`), never the DomTool union or content's DomTool listener.
// A per-origin `optional_host_permissions` grant is requested at call time; a denial surfaces
// as an error `ToolResult` the agent relays to the user.
export const BrowseInput = z.object({
  type: z.literal('browse'),
  url: z.string().url(),
});
export type BrowseInput = z.infer<typeof BrowseInput>;

// SW -> browse-tab content: compute a compact, token-bounded "design read" of the loaded page
// (its visual identity). Content replies with a `DesignReadResult`. Distinct from `DomTool`:
// it targets the browse tab, not the user's active tab. `maxColors` bounds the palette size.
export const DesignReadRequest = z.object({
  type: z.literal('design-read'),
  maxColors: z.number().int().positive().optional(),
});
export type DesignReadRequest = z.infer<typeof DesignReadRequest>;

// One palette entry: a normalized `#rrggbb`, the dominant role it plays (text / background /
// border), and how many elements use it that way — so the agent can copy a palette by weight.
export const PaletteColor = z.object({
  hex: z.string(),
  role: z.enum(['text', 'background', 'border']),
  count: z.number().int().nonnegative(),
});
export type PaletteColor = z.infer<typeof PaletteColor>;

// The type system in use: font families ordered by usage, the distinct font-size scale
// (descending px), and the body's base size — the reference's typographic identity in text.
export const Typography = z.object({
  families: z.array(z.string().max(120)).max(16),
  scale: z.array(z.number().int().positive()).max(32),
  baseSize: z.number().int().positive().optional(),
});
export type Typography = z.infer<typeof Typography>;

// A layout landmark (banner / navigation / main / complementary / contentinfo / ...) with its
// accessible name — the reference's structural regions.
export const DesignRegion = z.object({ role: z.string(), name: z.string() });
export type DesignRegion = z.infer<typeof DesignRegion>;

// A recurring UI building block (buttons / links / inputs / headings / images / ...) and how
// many the page has — the reference's component vocabulary.
export const DesignComponent = z.object({ kind: z.string(), count: z.number().int().positive() });
export type DesignComponent = z.infer<typeof DesignComponent>;

// The compact, token-bounded design read `browse` returns as `ToolResult.data`: a site's
// visual identity in text (palette + typography + regions + components) — cheaper than a
// screenshot and reusable, so the agent can capture a reference once, then copy it.
// Bounds are defense-in-depth: the extractor already caps every list (src/dom/design-read.ts
// MAX_*), but the SW treats the content-world reply as untrusted, so a compromised page can't
// return an unbounded blob that blows the agent's token budget. Caps sit above the extractor's.
export const DesignRead = z.object({
  url: z.string().max(2048),
  title: z.string().max(300),
  palette: z.array(PaletteColor).max(64),
  typography: Typography,
  regions: z.array(DesignRegion).max(64),
  components: z.array(DesignComponent).max(48),
});
export type DesignRead = z.infer<typeof DesignRead>;

export const DesignReadResult = z.object({
  type: z.literal('design-read-result'),
  ok: z.boolean(),
  read: DesignRead.optional(),
  error: z.string().optional(),
});
export type DesignReadResult = z.infer<typeof DesignReadResult>;

// --- browser control: SW-orchestrated tools (navigation / tabs / frames / vision) ----------
// Unlike the content-routed DomTool/ControlTool sets, these need `chrome.tabs`,
// `chrome.webNavigation`, or the vision model — all SW-side (content has no `chrome.tabs`, and the
// provider key/model never cross into the page's world). So each rides its own input + typed
// `ToolResult.data` payload, exactly like `browse`: the agent tool wrappers
// (`src/agent/tools/{interact,tabs,vision}.ts`) derive from these consts and the SW
// (`background.ts`) executes them — never the content DomTool listener.

// Navigation — the SW drives `chrome.tabs.update` (url) / `goBack` / `reload`, then awaits load. It
// tears down + re-injects the target's content script, so it cannot be content-routed. `navigate`
// warns before discarding an unsaved live-edit session (edits are ephemeral — slice 13 step 5).
export const NavigateInput = z.object({
  type: z.literal('navigate'),
  url: z.string().url(),
  ...Target.shape,
});
export const NavigateBackInput = z.object({
  type: z.literal('navigateBack'),
  ...Target.shape,
});
export const ReloadInput = z.object({
  type: z.literal('reload'),
  ...Target.shape,
});
// The three navigation intents as one union — SW routing (`background.ts`) switches on `type`.
export const NavIntent = z.discriminatedUnion('type', [
  NavigateInput,
  NavigateBackInput,
  ReloadInput,
]);
export type NavIntent = z.infer<typeof NavIntent>;

// Where a navigation landed (`ToolResult.data` for the nav tools) so the agent knows the new page.
export const NavResult = z.object({
  url: z.string().max(2048),
  title: z.string().max(300).optional(),
});
export type NavResult = z.infer<typeof NavResult>;

// Multi-tab manager (the SW owns the tab registry + per-tab session/changeset). `open` needs `url`;
// `close` / `activate` need `tabId`; `list` neither. Copy runs the user's tab + a reference tab at
// once, the agent addressing each by `tabId` (the shared `Target` on the other tools).
export const TabsCmd = z.object({
  type: z.literal('tabs'),
  action: z.enum(['list', 'open', 'close', 'activate']),
  url: z.string().url().optional(),
  tabId: z.number().int().nonnegative().optional(),
});
export type TabsCmd = z.infer<typeof TabsCmd>;

export const TabInfo = z.object({
  tabId: z.number().int().nonnegative(),
  url: z.string().max(2048),
  title: z.string().max(300),
  active: z.boolean(),
});
export type TabInfo = z.infer<typeof TabInfo>;

// `tabs` payload: the full tab registry after the command runs (list / open / activate / close all
// return it, so the agent always sees current state). Bounded against a tab-bomb page.
export const TabsResult = z.object({ tabs: z.array(TabInfo).max(50) });
export type TabsResult = z.infer<typeof TabsResult>;

// Enumerate a tab's frame tree (`chrome.webNavigation.getAllFrames`) so the agent can target an
// iframe by `frameId`. Takes only a `tabId` (via `Target`); `frameId` is unused for a list.
export const FramesInput = z.object({
  type: z.literal('frames'),
  action: z.literal('list'),
  ...Target.shape,
});
export type FramesInput = z.infer<typeof FramesInput>;

export const FrameInfo = z.object({
  frameId: z.number().int().nonnegative(),
  url: z.string().max(2048),
  origin: z.string().max(2048),
  isMain: z.boolean(),
});
export type FrameInfo = z.infer<typeof FrameInfo>;

// `frames` payload: every frame in the tab, bounded.
export const FramesResult = z.object({ frames: z.array(FrameInfo).max(100) });
export type FramesResult = z.infer<typeof FramesResult>;

// Ask the vision model about a captured region: screenshot `selector` (or the viewport, or
// `fullPage`), hand it to the vision-capable model as an image part, and return its verdict for
// self-correction ("does the CTA contrast enough?"). SW-only (owns capture + the model) and
// cost-aware — only on demand, counted as a vision sub-call against the turn budget (slice 13).
export const InspectVisuallyInput = z.object({
  type: z.literal('inspectVisually'),
  question: z.string().min(1).max(500),
  selector: z.string().optional(),
  fullPage: z.boolean().optional(),
  ...Target.shape,
});
export type InspectVisuallyInput = z.infer<typeof InspectVisuallyInput>;

// The vision model's answer (`ToolResult.data`). `pass` is an optional yes/no distillation for a
// boolean check the agent can branch on without re-reading the prose.
export const InspectVisuallyResult = z.object({
  verdict: z.string().max(4000),
  pass: z.boolean().optional(),
});
export type InspectVisuallyResult = z.infer<typeof InspectVisuallyResult>;

// --- describe-in-text + design identity (slice 14) ------------------------
// Two agent asks the earlier reads don't cover: turn a page/region/image into compact TEXT (so a
// non-vision model, a report, or a handoff spec can reason without pixels), and extract a site's
// visual IDENTITY (role-tagged palette + type scale + spacing/radius/shadow) so `copy` reuses the
// source's brand and reports speak in tokens, not raw hex. The cheap paths are content-routed DOM
// reads (`src/dom/{describe,identity,images}.ts`); the `scene` describe + `readImageContent` prose
// escalate to the vision model in the SW (reusing the slice-13 `inspectVisually` capture path). All
// three ride the `DescribeCmd` union `content.ts` parses beside DomTool/ControlTool; the agent tools
// derive 1:1 from the input consts in `src/agent/tools/{describe,identity}.ts`. Result payloads are
// bounded above the extractors' own caps — defense-in-depth against an untrusted content-world reply,
// exactly as `DesignRead` / `ReadImagesResult` are.

// `describe` mode: `layout`/`content` are cheap DOM-only text; `scene` screenshots the region and
// asks the vision model for prose — so the tool routes `scene` to the SW and the text modes to
// content. The content DOM builder only produces the two text modes; it never sees `scene`.
export const DescribeMode = z.enum(['layout', 'content', 'scene']);
export type DescribeMode = z.infer<typeof DescribeMode>;

export const DescribeInput = z.object({
  type: z.literal('describe'),
  selector: z.string().optional(),
  mode: DescribeMode,
  ...Target.shape,
});
export type DescribeInput = z.infer<typeof DescribeInput>;

// `describe` payload (`ToolResult.data`): the mode that ran + its compact text — the DOM builder's
// layout/content skeleton, or the vision model's scene prose. Bounded well above the extractor's
// 2000-char clip so the SW scene prose fits too.
export const DescribeResult = z.object({
  mode: DescribeMode,
  text: z.string().max(8000),
});
export type DescribeResult = z.infer<typeof DescribeResult>;

// Extract the page's design identity. Whole-document by design — a site's identity is a page-level
// concept; address a specific frame/tab via `Target`, not a sub-selector. Pure DOM read →
// `IdentityResult`.
export const ExtractIdentityInput = z.object({
  type: z.literal('extractIdentity'),
  ...Target.shape,
});
export type ExtractIdentityInput = z.infer<typeof ExtractIdentityInput>;

// One identity color: normalized `#rrggbb`, the role it plays most (bg / fg / accent / border), and
// how many sampled elements use it that way — so `copy` can rebuild a palette by weight + role.
export const IdentityColor = z.object({
  hex: z.string().max(9),
  role: z.enum(['bg', 'fg', 'accent', 'border']),
  count: z.number().int().nonnegative(),
});
export type IdentityColor = z.infer<typeof IdentityColor>;

// The type system: font families (most-used first), the distinct size scale (descending px), and the
// distinct numeric weights — the page's typographic identity in tokens.
export const IdentityTypeScale = z.object({
  families: z.array(z.string().max(120)).max(8),
  sizes: z.array(z.number().int().positive()).max(20),
  weights: z.array(z.number().int().positive()).max(16),
});
export type IdentityTypeScale = z.infer<typeof IdentityTypeScale>;

// `extractIdentity` payload (`ToolResult.data`): a compact, token-like identity — role-tagged palette,
// type scale, and the spacing / border-radius / box-shadow rhythm — reused by `copy` and rendered as a
// tokens table in reports. Bounds sit above `src/dom/identity.ts`'s own caps (defense-in-depth).
export const IdentityResult = z.object({
  palette: z.array(IdentityColor).max(24),
  type: IdentityTypeScale,
  spacing: z.array(z.number().int().nonnegative()).max(16),
  radius: z.array(z.number().int().nonnegative()).max(12),
  shadows: z.array(z.string().max(200)).max(12),
});
export type IdentityResult = z.infer<typeof IdentityResult>;

// Describe one image — the `<img>` / media element matching `selector`. The content leg resolves its
// alt + src; the SW escalates to the vision model for a prose description when alt is thin (cost-aware
// — vision only on request). Result = `ImageDescription`.
export const ReadImageContentInput = z.object({
  type: z.literal('readImageContent'),
  selector: z.string(),
  ...Target.shape,
});
export type ReadImageContentInput = z.infer<typeof ReadImageContentInput>;

// `readImageContent` payload (`ToolResult.data`): the resolved image + a text `description` of what it
// depicts — the vision model's prose, or the `alt` text when no vision call was made (feeds copy /
// report when alt is missing). Bounds cap an untrusted content-world reply.
export const ImageDescription = z.object({
  selector: StableSelector.optional(),
  src: z.string().max(2048).optional(),
  alt: z.string().max(500).optional(),
  description: z.string().max(4000),
});
export type ImageDescription = z.infer<typeof ImageDescription>;

// The content-routed describe-family union — `content.ts` parses it beside DomTool/ControlTool and
// runs each against the live DOM (`describe`'s text modes, `extractIdentity`, and `readImageContent`'s
// alt/src leg). A `describe` with `mode: 'scene'` is served by the SW vision path, never routed here.
export const DescribeCmd = z.discriminatedUnion('type', [
  DescribeInput,
  ExtractIdentityInput,
  ReadImageContentInput,
]);
export type DescribeCmd = z.infer<typeof DescribeCmd>;

// --- recorder events (shared) --------------------------------------------
// The reversible, element-targeting mutation primitives that emit a recorder
// event (docs/idea/live-edit.md). Page-level ops (injectCss, setViewport) have no
// single element target and so are not MutationEvents (which require a selector).
export const MutationKind = z.enum([
  'setStyle',
  'setText',
  'setAttr',
  'addClass',
  'removeClass',
  'insertNode',
  'moveNode',
  'removeNode',
]);
export type MutationKind = z.infer<typeof MutationKind>;

// One recorded, invertible page mutation. Consumed by #5 (undo), #9 (recorder),
// #10 (fold/remove). `before`/`after` are the serialized prior/next state; the
// absent side of an insert/remove is the empty string. `ruleId` ties a setStyle
// back to its rule in the injected stylesheet so undo can drop it.
export const MutationEvent = z.object({
  kind: MutationKind,
  selector: StableSelector,
  before: z.string(),
  after: z.string(),
  ruleId: z.string().optional(),
  ts: z.number(),
});
export type MutationEvent = z.infer<typeof MutationEvent>;

// --- content -> service worker (push) ------------------------------------
// The first content-originated push direction: the picker's selection events and
// the recorder's mutation events. Doc-sanctioned (docs/architecture/mv3-worlds.md,
// docs/idea/agent.md both describe a content -> SW RecorderEvent).
export const ContentToSw = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('element-picked'),
    candidates: z.array(StableSelector),
    rect: Rect,
    styles: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ type: z.literal('multi-select-changed'), selectors: z.array(StableSelector) }),
  z.object({ type: z.literal('picker-state'), active: z.boolean() }),
  z.object({ type: z.literal('recorder-event'), event: MutationEvent }),
  // The debug engine's real-time half (slice 06, complements the `diagnostics` DomTool pull
  // above): the content collector (src/dom/diagnostics-collector.ts) pushes each runtime/network
  // signal as it's captured, so a debug-mode turn can observe as the user drives the page instead
  // of waiting for an explicit `drain`. The SW folds these into the turn's diagnostics buffer
  // (src/agent/diagnostics.ts `aggregate`/`correlate`); relay.ts intentionally does not forward
  // this one to the panel (it's an engine input, not a user-facing event).
  z.object({ type: z.literal('diagnostics-signal'), signal: CollectorSignal }),
]);
export type ContentToSw = z.infer<typeof ContentToSw>;

// --- content -> service worker (screenshot capture, request/response) -----
// The content script can't call `chrome.tabs.captureVisibleTab` (the page's world has no `tabs`
// capture); it computes the crop rect (`src/dom/read.ts` `screenshotRect`) and asks the SW here.
// The SW grabs the visible tab, crops to `rect` (page CSS px, scaled by `devicePixelRatio`), and
// replies with a base64 PNG data URL for the agent's vision self-correction (slice 04). This is
// NOT a `ContentToSw` member: that union is push-only (relayed to the panel), whereas capture is
// a request/response, so it rides its own listener in `background.ts`.
export const CaptureRequest = z.object({
  type: z.literal('capture-visible-tab'),
  rect: Rect,
  devicePixelRatio: z.number().positive(),
});
export type CaptureRequest = z.infer<typeof CaptureRequest>;

export const CaptureResult = z.object({
  ok: z.boolean(),
  // A `data:image/png;base64,...` URL of the (cropped) capture. Absent when `ok` is false.
  dataUrl: z.string().optional(),
  error: z.string().optional(),
});
export type CaptureResult = z.infer<typeof CaptureResult>;

// --- full-page capture: page metrics (SW -> content, request/response) -----
// A full-page `screenshot` scroll-stitches viewport grabs in the SW (only it has
// `captureVisibleTab` + OffscreenCanvas). To plan the scroll bands the SW needs the page's
// scroll + viewport geometry, which only the DOM world knows — so it asks the content script for
// it here (mirroring `DesignReadRequest`). NOT a `DomTool`/`ControlTool`: it is an internal step of
// the full-page capture, never an agent-facing tool. `Target.frameId` addresses the frame to read
// (full-page capture uses the top document, frameId 0).
export const PageMetricsRequest = z.object({ type: z.literal('page-metrics'), ...Target.shape });
export type PageMetricsRequest = z.infer<typeof PageMetricsRequest>;

// The page's scroll + viewport geometry in CSS px (+ `devicePixelRatio`). The SW turns this into a
// stitch plan (`src/dom/read.ts` `planStitch`): how far to scroll for each band and where each band
// lands on the device-px canvas.
export const PageMetrics = z.object({
  scrollWidth: z.number().nonnegative(),
  scrollHeight: z.number().nonnegative(),
  viewportWidth: z.number().positive(),
  viewportHeight: z.number().positive(),
  devicePixelRatio: z.number().positive(),
  scrollX: z.number(),
  scrollY: z.number(),
});
export type PageMetrics = z.infer<typeof PageMetrics>;

export const PageMetricsResult = z.object({
  type: z.literal('page-metrics-result'),
  ok: z.boolean(),
  metrics: PageMetrics.optional(),
  error: z.string().optional(),
});
export type PageMetricsResult = z.infer<typeof PageMetricsResult>;

// --- page facts + MAIN-world bridge (slice 15) ----------------------------
// Real apps are SPAs whose framework internals + chart-lib instances live ONLY in the page's own JS
// world (MAIN). The isolated content world can't read them, so a MAIN-world content script
// (`src/entrypoints/injected.content.ts`) exposes a NARROW, READ-ONLY RPC over `window.postMessage`,
// guarded by an origin + per-request nonce check (`src/dom/bridge.ts`). It carries page facts + (a
// later task) chart data only — NEVER a key or token: MAIN == the page's own world, untrusted
// (CLAUDE.md "MV3 three worlds", docs/architecture/security.md). `PageFacts` is the detection result,
// cached per URL in the content world (`src/dom/page-facts.ts`) and later fed to the agent as context
// + `frameworkHints` on edits.
export const PageFacts = z.object({
  // Detected UI frameworks, most-specific/most-confident first (`next`, `nuxt`, `react`, `vue`,
  // `svelte`, `angular`, `solid`, `preact`, ...). Bounded — a page rarely ships more than a few.
  frameworks: z.array(z.string()).max(12),
  // Detected chart / dataviz libs (`chartjs`, `echarts`, `highcharts`, `d3`, `plotly`, `recharts`,
  // ...) so the chart reader (slice 15E) knows a data probe is worth trying before pixel-reading.
  chartLibs: z.array(z.string()).max(12),
  // Other notable runtime libs worth knowing when source-mapping an edit (`jquery`, `gsap`, `three`,
  // `bootstrap`, `alpine`, ...).
  libraries: z.array(z.string()).max(24),
  // Client-rendered SPA (a framework + a mount root): the agent awaits hydration/quiescence and
  // re-derives facts on client-side route changes (slice 15A) before acting.
  spa: z.boolean(),
  // The document URL these facts describe — the content-world cache key + a staleness check after a
  // SPA route change.
  url: z.string(),
});
export type PageFacts = z.infer<typeof PageFacts>;

// The read-only methods the MAIN-world bridge answers: framework/lib detection (`page-facts`) + a
// chart-data probe (`chart-data`, extracts series from the page's own chart-lib instances — slice
// 15E). Both are non-secret page reads; anything not in this enum is rejected by the server.
export const BridgeMethod = z.enum(['page-facts', 'chart-data']);
export type BridgeMethod = z.infer<typeof BridgeMethod>;

// Namespaces our postMessage traffic off the page's own chatter (many sites postMessage heavily).
export const BRIDGE_SOURCE = 'devz-designer-bridge';

// Content world -> MAIN world. `nonce` is a fresh per-request token the server echoes back so the
// client can correlate + reject a stale/spoofed reply; the origin + `source === window` checks on
// both ends are the real guard (a cross-origin frame's message is dropped). Read-only: a `method`
// name only, never a secret-bearing param.
export const BridgeRequest = z.object({
  source: z.literal(BRIDGE_SOURCE),
  dir: z.literal('req'),
  nonce: z.string(),
  method: BridgeMethod,
});
export type BridgeRequest = z.infer<typeof BridgeRequest>;

// MAIN world -> content world. Echoes the request `nonce`; `result` is the (non-secret) method
// payload on success, else `error`. `result` stays `unknown` — the caller validates it with the
// method's own schema (e.g. `PageFacts`).
export const BridgeResponse = z.object({
  source: z.literal(BRIDGE_SOURCE),
  dir: z.literal('res'),
  nonce: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type BridgeResponse = z.infer<typeof BridgeResponse>;

// --- widget recipes + chart reading (slice 15D/E) -------------------------
// Real apps hide data behind web-component widgets (datetime/combobox/slider/modal/…) and draw real
// charts on <canvas>/WebGL/SVG that have no element-per-datum. Two capabilities close the gap:
//   • WidgetRecipe — an ARIA-anchored interaction sequence the agent invokes to DRIVE a widget;
//     content resolves it by its `role` contract (robust to styling) and fires realistic events.
//     Built on the slice-13 control primitives; result data = `WidgetActed`.
//   • ChartRead — the agent READS a chart: first a guarded MAIN-world data probe (`chart-data`
//     bridge method — pulls series from the chart lib's own instances), else a vision fallback
//     (screenshot the host + describe). Read-only in the page world — never leaks a secret.

// One data series pulled from a chart instance. `values` keeps `null` gaps (a chart's missing points)
// so it stays index-aligned with the chart's shared `labels`. Bounded so a dataset can't blow the budget.
export const ChartSeries = z.object({
  name: z.string().max(160).optional(),
  values: z.array(z.number().nullable()).max(500),
});
export type ChartSeries = z.infer<typeof ChartSeries>;

// One chart's extracted data: the lib that drew it, its kind (bar/line/pie/…), title, axis titles, a
// CSS locator back to the host element (so the agent can screenshot/hover it), the shared category-axis
// labels, and the series. Labels are hoisted here (not repeated per series) so N series over one axis
// don't multiply the payload. Every field beyond `lib`/`series` is best-effort — a lib that doesn't
// expose it just omits it.
export const ChartData = z.object({
  lib: z.string().max(40),
  kind: z.string().max(40).optional(),
  title: z.string().max(200).optional(),
  selector: z.string().max(1024).optional(),
  axes: z
    .object({ x: z.string().max(160).optional(), y: z.string().max(160).optional() })
    .optional(),
  // Shared category/x-axis labels, index-aligned with every series' `values`. Absent for label-less
  // charts (scatter/pie).
  labels: z.array(z.string().max(160)).max(500).optional(),
  series: z.array(ChartSeries).max(24),
});
export type ChartData = z.infer<typeof ChartData>;

// The `chart-data` bridge method's payload (MAIN -> content): every chart the page-world extractor
// could reach. Bounded — a page rarely draws more than a handful.
export const ChartDataResult = z.object({ charts: z.array(ChartData).max(12) });
export type ChartDataResult = z.infer<typeof ChartDataResult>;

// The chart reader's result (`src/dom/charts.ts`). `source:'data'` = numeric series were extracted
// (via the bridge or a DOM-only pass); `source:'vision'` = nothing reachable, so `targets` names the
// host selectors the agent screenshots + describes instead (canvas/WebGL/closed lib). `reason` says why.
export const ChartRead = z.object({
  source: z.enum(['data', 'vision']),
  charts: z.array(ChartData).max(12).default([]),
  targets: z.array(z.string().max(1024)).max(12).default([]),
  reason: z.string().max(200).optional(),
});
export type ChartRead = z.infer<typeof ChartRead>;

// Each recipe is a `type` discriminant + the target selector + the desired end state. Content resolves
// the widget by its ARIA role (`role=combobox/listbox/slider/dialog/tab/…`) and fires a realistic
// event sequence, so a recipe survives restyling. All spread `Target` for frame/tab addressing, like
// the slice-13 control tools they build on.
export const DatetimeRecipe = z.object({
  type: z.literal('datetime'),
  // The trigger/input that opens the calendar.
  selector: z.string(),
  // Target day as ISO `YYYY-MM-DD`.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ...Target.shape,
});
export const ComboboxRecipe = z.object({
  type: z.literal('combobox'),
  // The combobox input (`role=combobox`, or an `<input>` with an attached listbox).
  selector: z.string(),
  // The option to choose, matched against each option's visible text / `aria-label`.
  value: z.string(),
  ...Target.shape,
});
export const SliderRecipe = z.object({
  type: z.literal('slider'),
  // A `role=slider` element or an `<input type=range>`.
  selector: z.string(),
  value: z.number(),
  ...Target.shape,
});
export const ToggleRecipe = z.object({
  type: z.literal('toggle'),
  // A `role=switch`/`checkbox`, `[aria-pressed]` button, or an `<input type=checkbox>`.
  selector: z.string(),
  on: z.boolean(),
  ...Target.shape,
});
export const ModalRecipe = z.object({
  type: z.literal('modal'),
  // For `open`, the trigger; for `confirm`/`dismiss`, the dialog (`role=dialog`/`alertdialog`).
  selector: z.string(),
  action: z.enum(['open', 'confirm', 'dismiss']),
  ...Target.shape,
});
export const TabsRecipe = z.object({
  type: z.literal('tabs'),
  // The tablist / accordion container (or a single tab).
  selector: z.string(),
  // The tab to select — its visible label / `aria-label`, or a 0-based index as a string.
  value: z.string(),
  ...Target.shape,
});
export const CarouselRecipe = z.object({
  type: z.literal('carousel'),
  // The carousel region (`aria-roledescription=carousel` or a `.carousel`-like root).
  selector: z.string(),
  direction: z.enum(['next', 'prev']),
  // How many slides to advance (default 1), bounded so a stuck control can't loop forever.
  times: z.number().int().positive().max(50).optional(),
  ...Target.shape,
});
export const DragDropRecipe = z.object({
  type: z.literal('dragDrop'),
  // The element to pick up.
  selector: z.string(),
  // The drop target.
  to: z.string(),
  ...Target.shape,
});
export const WidgetRecipe = z.discriminatedUnion('type', [
  DatetimeRecipe,
  ComboboxRecipe,
  SliderRecipe,
  ToggleRecipe,
  ModalRecipe,
  TabsRecipe,
  CarouselRecipe,
  DragDropRecipe,
]);
export type WidgetRecipe = z.infer<typeof WidgetRecipe>;

// A widget recipe's `ToolResult.data`: which widget ran, whether it reached its goal, a bounded trace
// of the steps it fired (the agent reads what happened), and the widget's final observed ARIA state.
export const WidgetActed = z.object({
  widget: z.string().max(40),
  reached: z.boolean(),
  steps: z.array(z.string().max(160)).max(64),
  state: z.record(z.string(), z.string()).optional(),
});
export type WidgetActed = z.infer<typeof WidgetActed>;

// --- complex-site control tools (slice 15, expose-to-agent) ---------------
// The remaining slice-15 content-routed inputs: read the page's detected stack (`pageFacts`), read
// a chart's data or vision-fallback targets (`readChart`), hover one for its HTML tooltip
// (`chartTooltip`), and drive an ARIA widget recipe (`widgetAct`). All route through content.ts
// exactly like the rest of `ControlTool` (`Target`-addressed, frame/tab aware).
export const ReadChartInput = z.object({
  type: z.literal('readChart'),
  // Scope to one chart host (e.g. a `readChart`'s prior `vision` target); omitted reads every
  // chart the page-facts/data-probe/DOM pass can reach.
  selector: z.string().optional(),
  ...Target.shape,
});
export type ReadChartInput = z.infer<typeof ReadChartInput>;

export const ChartTooltipInput = z.object({
  type: z.literal('chartTooltip'),
  // The chart host to hover — a `readChart` `vision` target's selector.
  selector: z.string(),
  ...Target.shape,
});
export type ChartTooltipInput = z.infer<typeof ChartTooltipInput>;

export const WidgetActInput = z.object({
  type: z.literal('widgetAct'),
  // The widget's ARIA-anchored recipe — its own `selector` + `Target` address the element within
  // the frame this message already routes to (see `WidgetRecipe` above).
  recipe: WidgetRecipe,
  ...Target.shape,
});
export type WidgetActInput = z.infer<typeof WidgetActInput>;

export const PageFactsInput = z.object({ type: z.literal('pageFacts'), ...Target.shape });
export type PageFactsInput = z.infer<typeof PageFactsInput>;

// The content-routed slice-13/15 driving + complex-site tools as one discriminated union —
// `content.ts` parses it beside `DomTool`, and `createInteractTools`/`createComplexSiteTools`
// derive one `tool()` per member 1:1, the same zero-drift contract `DomTool`/`createDomTools` hold.
export const ControlTool = z.discriminatedUnion('type', [
  ClickInput,
  TypeInput,
  PressKeyInput,
  HoverInput,
  ScrollToInput,
  SelectOptionInput,
  WaitForInput,
  HandleDialogInput,
  ReadImagesInput,
  ReadChartInput,
  ChartTooltipInput,
  WidgetActInput,
  PageFactsInput,
]);
export type ControlTool = z.infer<typeof ControlTool>;

// --- device emulation + responsive capture (slice 16) --------------------
// "Also check how it looks on mobile." The agent must SEE and TEST mobile/tablet/desktop, not just
// the current viewport. Three capabilities: `setDevice` emulates a real device (CDP device metrics +
// touch + UA in the SW, or a viewport-resize fallback when the `debugger` permission is declined);
// `responsiveCapture` screenshots the page across breakpoints for the vision model + report;
// `checkResponsive` runs the content-world problem scanner (`src/dom/responsive.ts`, slice 16 scanner
// task) at the current — possibly emulated — width. `setDevice`/`responsiveCapture` are SW-owned
// (they need `chrome.debugger`/`chrome.tabs` capture), so they ride their own input consts executed
// in `background.ts` like `browse`/nav/vision; `checkResponsive` is content-routed like a read.

// Named device presets the executor resolves to concrete metrics (`src/agent/device-emulation.ts`
// `DEVICE_PRESETS`). `desktop` restores a plain large viewport with no touch/mobile UA.
export const DevicePreset = z.enum(['iphone-se', 'iphone-15', 'pixel-7', 'ipad-mini', 'desktop']);
export type DevicePreset = z.infer<typeof DevicePreset>;

// The concrete metrics an emulation resolves to (a preset expanded, or custom dims filled in):
// CSS-px `width`×`height`, device-pixel-ratio, touch emulation, the `mobile` flag CDP's
// `setDeviceMetricsOverride` takes, and the optional UA override. Returned to the agent so it knows
// exactly what it's viewing at.
export const DeviceMetrics = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  dpr: z.number().positive(),
  touch: z.boolean(),
  mobile: z.boolean(),
  userAgent: z.string().max(512).optional(),
});
export type DeviceMetrics = z.infer<typeof DeviceMetrics>;

// How an emulation was applied: `cdp` = true device emulation via `chrome.debugger` (DPR + touch +
// UA; the visible "being debugged" banner is up); `viewport` = the resize-only fallback (approximates
// layout, not UA/touch) used when the debugger permission is declined or attach fails; `reset` =
// emulation cleared, page back to its natural state.
export const EmulationMechanism = z.enum(['cdp', 'viewport']);
export type EmulationMechanism = z.infer<typeof EmulationMechanism>;

// `setDevice`: apply a `preset` OR custom `width`×`height` (+ optional dpr/touch/ua overrides), or
// `reset: true` to clear emulation. Preset-vs-custom is validated in the executor (returns an error
// ToolResult, like `tabs` open needing a url) so this stays a plain object `.omit({type:true})` can
// derive the tool from. Custom dims on top of a preset override that preset's field.
export const SetDeviceInput = z.object({
  type: z.literal('setDevice'),
  preset: DevicePreset.optional(),
  width: z.number().int().positive().max(5000).optional(),
  height: z.number().int().positive().max(5000).optional(),
  dpr: z.number().positive().max(5).optional(),
  touch: z.boolean().optional(),
  userAgent: z.string().max(512).optional(),
  reset: z.boolean().optional(),
  ...Target.shape,
});
export type SetDeviceInput = z.infer<typeof SetDeviceInput>;

// `setDevice` payload (`ToolResult.data`): the human label, what mechanism applied it, whether the
// debug banner is now showing (surface it to the user), and the resolved metrics (absent on `reset`).
export const SetDeviceResult = z.object({
  label: z.string().max(80),
  mechanism: z.enum(['cdp', 'viewport', 'reset']),
  banner: z.boolean(),
  metrics: DeviceMetrics.optional(),
});
export type SetDeviceResult = z.infer<typeof SetDeviceResult>;

// One breakpoint for `responsiveCapture`: a `preset` or custom dims, with an optional `label`. Same
// resolver as `setDevice` (`resolveDevice`), so the shapes stay in lockstep.
export const Breakpoint = z.object({
  label: z.string().max(40).optional(),
  preset: DevicePreset.optional(),
  width: z.number().int().positive().max(5000).optional(),
  height: z.number().int().positive().max(5000).optional(),
  dpr: z.number().positive().max(5).optional(),
  touch: z.boolean().optional(),
});
export type Breakpoint = z.infer<typeof Breakpoint>;

// `responsiveCapture`: screenshot the page across `breakpoints` (default mobile/tablet/desktop —
// `src/agent/device-emulation.ts` `DEFAULT_BREAKPOINTS`). `selector` crops one element, `fullPage`
// scroll-stitches each breakpoint. Emulation is restored to the page's natural state after the sweep.
export const ResponsiveCaptureInput = z.object({
  type: z.literal('responsiveCapture'),
  breakpoints: z.array(Breakpoint).max(8).optional(),
  selector: z.string().optional(),
  fullPage: z.boolean().optional(),
  ...Target.shape,
});
export type ResponsiveCaptureInput = z.infer<typeof ResponsiveCaptureInput>;

// One breakpoint's shot: its label + resolved metrics + how it was emulated, and either the base64
// PNG (`image`) or a per-breakpoint `error` (one failed grab doesn't abort the sweep). The loop's
// `responsiveCaptureToModelOutput` hook turns the set into labeled image parts the vision model sees.
export const ResponsiveShot = z.object({
  label: z.string().max(60),
  metrics: DeviceMetrics,
  mechanism: EmulationMechanism,
  image: z.string().optional(),
  error: z.string().max(300).optional(),
});
export type ResponsiveShot = z.infer<typeof ResponsiveShot>;

export const ResponsiveCaptureResult = z.object({ shots: z.array(ResponsiveShot).max(8) });
export type ResponsiveCaptureResult = z.infer<typeof ResponsiveCaptureResult>;

// A responsive problem the content scanner found — mirrors `src/dom/responsive.ts`'s `ResponsiveFinding`
// (that module stays chrome-free/jsdom-testable and owns the geometry; this is its bus shape). Bounds
// sit above the scanner's own caps (defense-in-depth against an untrusted content-world reply).
export const ResponsiveCategory = z.enum([
  'overflow',
  'tap-target',
  'text-legibility',
  'clip',
  'media-scaling',
  'nav',
  'viewport-unit',
]);
export type ResponsiveCategory = z.infer<typeof ResponsiveCategory>;

export const ResponsiveSeverity = z.enum(['serious', 'moderate', 'minor']);
export type ResponsiveSeverity = z.infer<typeof ResponsiveSeverity>;

export const ResponsiveFinding = z.object({
  category: ResponsiveCategory,
  severity: ResponsiveSeverity,
  detail: z.string().max(280),
  selector: StableSelector,
});
export type ResponsiveFinding = z.infer<typeof ResponsiveFinding>;

// `checkResponsive`: content-routed problem scan at the current (possibly emulated) width. `selector`
// scopes it to a subtree; omitted scans the document. Runs `scanResponsive` in the content world.
export const CheckResponsiveInput = z.object({
  type: z.literal('checkResponsive'),
  selector: z.string().optional(),
  ...Target.shape,
});
export type CheckResponsiveInput = z.infer<typeof CheckResponsiveInput>;

// `checkResponsive` payload (`ToolResult.data`): the width measured at + the findings, most-severe
// first. Feeds debug mode + the report (slice 16 doctrine task).
export const CheckResponsiveResult = z.object({
  viewportWidth: z.number().nonnegative(),
  findings: z.array(ResponsiveFinding).max(80),
});
export type CheckResponsiveResult = z.infer<typeof CheckResponsiveResult>;

// --- service worker -> panel (stream) ------------------------------------
export const SwToPanel = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), tool: z.string() }),
  z.object({ type: z.literal('edit-recorded'), edit: Edit }),
  z.object({ type: z.literal('changeset'), changeset: Changeset }),
  // One task's live status on the Ship timeline (slice 07). A multi-task fan-out streams several,
  // each tagged with its own `taskId`/`title` and `index`/`total` so the panel drives one timeline
  // per task; `status` is an open string (`queued → working → pr_open → ci_green/ci_red`, or
  // `error`, with `error` carrying the failure reason).
  z.object({
    type: z.literal('task-status'),
    taskId: z.string(),
    title: z.string(),
    index: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    status: z.string(),
    prUrl: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
  // SW relays of ContentToSw picker events.
  z.object({ type: z.literal('focus'), selector: StableSelector, rect: Rect }),
  z.object({ type: z.literal('picker-state'), active: z.boolean() }),
  // Picker shift-click multi-selection relayed from content: the panel highlights the set /
  // shows a count; an empty list clears it. Consumer: the on-page overlay reuses the picker
  // highlight (slice 09). Named for the panel's view (the current selection), not the event.
  z.object({ type: z.literal('multi-select'), selectors: z.array(StableSelector) }),
  // A live recorded page mutation relayed from content — the panel can show an edit chip as it
  // lands. Distinct from `edit-recorded`, which carries a finalized, intent-tagged `Edit`: this
  // is the raw reversible primitive. The SW also folds these into the session Changeset (07).
  z.object({ type: z.literal('recorder-event'), event: MutationEvent }),
  // Live connection-health push for one MCP server (add/connect/auth/remove, or an
  // explicit mcp-status refresh request) — the panel's mcpStore reflects this stream.
  z.object({ type: z.literal('mcp-status'), server: McpServer }),
  // Unsolicited readiness push whenever provider/model/host-permission/MCP health
  // changes, so the header pill updates without the panel polling the `readiness` RPC.
  z.object({ type: z.literal('readiness'), state: ReadinessState }),
  // Start/Stop session lifecycle: `idle` (pre-Start) -> `running` (session-start) ->
  // `stopped` (session-stop aborted the in-flight turn; session stays open for the next
  // message). See `SessionStart`/`SessionStop` above.
  z.object({ type: z.literal('session-state'), state: z.enum(['idle', 'running', 'stopped']) }),
]);
export type SwToPanel = z.infer<typeof SwToPanel>;
