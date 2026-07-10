import { z } from 'zod';

// Changeset schema — mirrors docs/idea/live-edit.md.
// A design session's accepted edits, portable enough for the dev-agent to
// map back to source during MCP handoff (see docs/idea/handoff.md).

export const SelectorStrategy = z.enum(['data-attr', 'id', 'aria', 'text', 'css-path']);
export type SelectorStrategy = z.infer<typeof SelectorStrategy>;

export const StableSelector = z.object({
  value: z.string(),
  strategy: SelectorStrategy,
  fragile: z.boolean().default(false),
});
export type StableSelector = z.infer<typeof StableSelector>;

export const StyleChange = z.object({
  prop: z.string(),
  before: z.string().nullable(),
  after: z.string(),
});
export type StyleChange = z.infer<typeof StyleChange>;

export const Edit = z.object({
  // The user's words for *why* — intent, not just the CSS dump.
  intent: z.string(),
  selector: StableSelector,
  changes: z.array(StyleChange).default([]),
  text: z.object({ before: z.string(), after: z.string() }).optional(),
  screenshots: z.object({ before: z.string(), after: z.string() }).partial().optional(),
  // Tailwind classes / css-module names / styled markers — the source-mapping bridge.
  frameworkHints: z.array(z.string()).default([]),
});
export type Edit = z.infer<typeof Edit>;

export const Changeset = z.object({
  url: z.url(),
  createdAt: z.string(),
  // Idempotency key for the #19 handoff: a retried `task(action:'create', {spec})`
  // after a network failure must resolve to the same session, not open a second PR.
  // The SW session owns it (crypto.randomUUID); nothing else in the schema fits.
  sessionId: z.uuid(),
  edits: z.array(Edit).default([]),
});
export type Changeset = z.infer<typeof Changeset>;

// sessionId is passed in, never minted here: the caller already knows its session,
// and an internally-generated uuid would be non-deterministic (untestable).
export function emptyChangeset(url: string, createdAt: string, sessionId: string): Changeset {
  return { url, createdAt, sessionId, edits: [] };
}

export function addEdit(changeset: Changeset, edit: Edit): Changeset {
  return { ...changeset, edits: [...changeset.edits, edit] };
}
