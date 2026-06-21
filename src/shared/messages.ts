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

export const PanelToSw = z.discriminatedUnion('type', [UserMessage, ShipRequest]);
export type PanelToSw = z.infer<typeof PanelToSw>;

// --- service worker -> content (DOM tools) -------------------------------
export const DomTool = z.discriminatedUnion('type', [
  z.object({ type: z.literal('query'), selector: z.string() }),
  z.object({ type: z.literal('getStyles'), selector: z.string() }),
  z.object({ type: z.literal('screenshot'), selector: z.string().optional() }),
  z.object({ type: z.literal('setStyle'), selector: z.string(), props: z.record(z.string()) }),
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
