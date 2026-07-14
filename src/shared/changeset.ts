import { z } from 'zod';

// Changeset schema — mirrors docs/idea/live-edit.md.
// A design session's accepted edits, portable enough for the dev-agent to
// map back to source during MCP handoff (see docs/idea/handoff.md).

// `shadow` = a host-path selector (`hostSelector >>> innerSelector`, one `>>>` per shadow boundary):
// CSS `querySelector` can't cross a shadow root, so a shadow-nested element is re-selected by replaying
// the path root->host->shadowRoot->… (see `resolveShadowSelector` in src/dom/selector.ts). Open roots
// pierce; a closed root can't be pierced, so its selector is flagged `fragile` and the agent falls back
// to coordinate/vision interaction on the host.
export const SelectorStrategy = z.enum(['data-attr', 'id', 'aria', 'text', 'css-path', 'shadow']);
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
  // Which breakpoint this edit targeted, when made under device emulation (slice 16) — a device
  // preset id or a custom label (e.g. "iphone-se" / "Tablet 768px"), set by `recordEdit` so the
  // changeset (and the report) show which viewport an edit was made for. Undefined = the page's
  // natural, non-emulated viewport.
  breakpoint: z.string().max(60).optional(),
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
