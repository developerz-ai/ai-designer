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
export const SaveKey = z.object({
  type: z.literal('save-openrouter-key'),
  text: z.string().min(1),
});
export const ListModels = z.object({ type: z.literal('list-models') });
export const SetModel = z.object({ type: z.literal('set-model'), model: z.string().min(1) });
export const KeyStatus = z.object({ type: z.literal('key-status') });
export const ClearKey = z.object({ type: z.literal('clear-openrouter-key') });

// User-driven element picker (panel button -> SW -> forwarded as a PickerCmd to
// content). Distinct from the agent's DomTool calls; the picker is never agent-run.
export const StartPicker = z.object({ type: z.literal('start-picker') });
export const StopPicker = z.object({ type: z.literal('stop-picker') });

export const PanelToSw = z.discriminatedUnion('type', [
  UserMessage,
  ShipRequest,
  SaveKey,
  ListModels,
  SetModel,
  KeyStatus,
  ClearKey,
  StartPicker,
  StopPicker,
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

export const ModelOption = z.object({ id: z.string(), name: z.string() });
export type ModelOption = z.infer<typeof ModelOption>;

export const ModelsResult = z.object({
  ok: z.boolean(),
  models: z.array(ModelOption).optional(),
  error: z.string().optional(),
});
export type ModelsResult = z.infer<typeof ModelsResult>;

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
]);
export type SwToPanel = z.infer<typeof SwToPanel>;
