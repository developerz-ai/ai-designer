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
// The condition `waitFor` blocks on: resolve as soon as `selector`/`text` appears or the network
// goes idle, capped by `timeMs` (hard max 30s so a stuck page can't hang the turn — slice 13
// guardrail). Given only `timeMs`, it is a plain bounded delay. Exported standalone for the tool
// wrapper (`src/agent/tools/interact.ts`) and the content impl (`src/dom/interact.ts`).
export const WaitCondition = z.object({
  selector: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  networkIdle: z.boolean().optional(),
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

// The content-routed slice-13 driving tools as one discriminated union — `content.ts` parses it
// beside `DomTool`, and `createControlTools` (slice 13) derives one `tool()` per member 1:1, the
// same zero-drift contract `DomTool`/`createDomTools` hold.
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
]);
export type ControlTool = z.infer<typeof ControlTool>;

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
