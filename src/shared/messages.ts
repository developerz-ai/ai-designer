import { z } from 'zod';
import { Changeset, Edit, StableSelector } from './changeset';

// Typed message bus across the three MV3 worlds: panel <-> service worker <-> content.
// Every payload is Zod-validated at the boundary. See docs/architecture/mv3-worlds.md.

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

export const PanelToSw = z.discriminatedUnion('type', [
  UserMessage,
  ShipRequest,
  SaveKey,
  ListModels,
  SetModel,
  KeyStatus,
  ClearKey,
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
export const DomTool = z.discriminatedUnion('type', [
  z.object({ type: z.literal('query'), selector: z.string() }),
  z.object({ type: z.literal('getStyles'), selector: z.string() }),
  z.object({ type: z.literal('screenshot'), selector: z.string().optional() }),
  z.object({
    type: z.literal('setStyle'),
    selector: z.string(),
    props: z.record(z.string(), z.string()),
  }),
  z.object({ type: z.literal('setText'), selector: z.string(), value: z.string() }),
  z.object({ type: z.literal('undo') }),
]);
export type DomTool = z.infer<typeof DomTool>;

export const ToolResult = z.object({
  type: z.literal('tool-result'),
  ok: z.boolean(),
  selector: StableSelector.optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

// --- service worker -> panel (stream) ------------------------------------
export const SwToPanel = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), tool: z.string() }),
  z.object({ type: z.literal('edit-recorded'), edit: Edit }),
  z.object({ type: z.literal('changeset'), changeset: Changeset }),
  z.object({ type: z.literal('task-status'), status: z.string(), prUrl: z.string().optional() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type SwToPanel = z.infer<typeof SwToPanel>;
