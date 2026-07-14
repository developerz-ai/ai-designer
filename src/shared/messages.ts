import { z } from 'zod';
import { Changeset, Edit, StableSelector } from './changeset';

// StableSelector lives in changeset.ts but is part of the message vocabulary; re-export
// it so panel/content consumers import the selector type from the message-schema hub.
export { StableSelector };

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
});

export const ShipRequest = z.object({
  type: z.literal('ship'),
  backend: z.string(), // configured MCP connection id
  summary: z.string(),
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

// --- service worker -> content (DOM tools) -------------------------------
// One named input const per tool. The DomTool union is built FROM these, so #11
// can derive `tool({ inputSchema })` 1:1 with zero drift — add a tool = add a
// const + one union entry. The `type` literal is both the bus discriminant and
// the tool name #11 maps to.
export const QueryInput = z.object({ type: z.literal('query'), selector: z.string() });
export const GetStylesInput = z.object({ type: z.literal('getStyles'), selector: z.string() });
export const ScreenshotInput = z.object({
  type: z.literal('screenshot'),
  selector: z.string().optional(),
});
export const SetStyleInput = z.object({
  type: z.literal('setStyle'),
  selector: z.string(),
  props: z.record(z.string(), z.string()),
});
export const SetTextInput = z.object({
  type: z.literal('setText'),
  selector: z.string(),
  value: z.string(),
});
export const A11ySnapshotInput = z.object({
  type: z.literal('a11ySnapshot'),
  selector: z.string(),
});
export const UndoInput = z.object({ type: z.literal('undo') });

export const DomTool = z.discriminatedUnion('type', [
  QueryInput,
  GetStylesInput,
  ScreenshotInput,
  SetStyleInput,
  SetTextInput,
  A11ySnapshotInput,
  UndoInput,
]);
export type DomTool = z.infer<typeof DomTool>;

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

// --- service worker -> panel (stream) ------------------------------------
export const SwToPanel = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), tool: z.string() }),
  z.object({ type: z.literal('edit-recorded'), edit: Edit }),
  z.object({ type: z.literal('changeset'), changeset: Changeset }),
  z.object({ type: z.literal('task-status'), status: z.string(), prUrl: z.string().optional() }),
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
