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

// One attribute delta (slice #139): `before: null` = the attribute was absent, `after: null` = it
// was removed — so a `setAttr` (and its undo) carries a machine-parseable delta, not just intent
// prose. Mirrors the volatile recorder's self-describing `{name: value}` (src/dom/recorder.ts).
export const AttrChange = z.object({
  name: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type AttrChange = z.infer<typeof AttrChange>;

// One class add/remove (slice #139) — the durable, shippable form of `addClass`/`removeClass`.
export const ClassChange = z.object({
  name: z.string(),
  op: z.enum(['add', 'remove']),
});
export type ClassChange = z.infer<typeof ClassChange>;

// One structural delta (#58): the durable, shippable form of an insertNode/moveNode/removeNode,
// discriminated on `op` so a contradictory payload can't validate (an insert without markup, a
// move without an anchor, a remove carrying one). Optional on Edit: most edits are property-level,
// so an absent field beats a null placeholder. The live page itself is never reverted by this
// record — it maps the change for the coding backend on Ship.
export const StructuralPosition = z.enum(['beforebegin', 'afterbegin', 'beforeend', 'afterend']);
export const StructuralChange = z.discriminatedUnion('op', [
  // .strict() — a model-populated field: unknown keys must REJECT, not silently strip (else a
  // contradictory payload like a `remove` carrying `html` "validates" with the extra key dropped).
  z
    .object({
      op: z.literal('insert'),
      html: z.string(),
      position: StructuralPosition.optional(),
      refSelector: StableSelector.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('move'),
      refSelector: StableSelector,
      position: StructuralPosition.optional(),
    })
    .strict(),
  z.object({ op: z.literal('remove') }).strict(),
]);
export type StructuralChange = z.infer<typeof StructuralChange>;

export const Edit = z.object({
  // The user's words for *why* — intent, not just the CSS dump.
  intent: z.string(),
  selector: StableSelector,
  changes: z.array(StyleChange).default([]),
  // Attribute + class deltas (#139). Both default to empty so a changeset persisted before these
  // fields existed still rehydrates (same forward-compat rule as `ChangesetState.redoStack`).
  attrs: z.array(AttrChange).default([]),
  classes: z.array(ClassChange).default([]),
  // The structural delta (#58) when this edit came from insertNode/moveNode/removeNode.
  structural: StructuralChange.optional(),
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

// The full serializable state of a `ChangesetStore` (src/changeset/store.ts): the live changeset
// plus the redo stack (edits popped by `undo`, newest last). Persisting only the `Changeset` would
// lose the redo history on an SW eviction — a rehydrated session could no longer `redo` an edit it
// had just undone. This is the unit `chrome.storage.session` round-trips so undo/redo survives a
// wake, exactly as the model thread does (docs/architecture/mv3-worlds.md "Service-worker
// ephemerality"). `redoStack` defaults to empty so a legacy record holding a bare `Changeset` shape
// still rehydrates (forward-compatible).
export const ChangesetState = z.object({
  changeset: Changeset,
  redoStack: z.array(Edit).default([]),
});
export type ChangesetState = z.infer<typeof ChangesetState>;

// sessionId is passed in, never minted here: the caller already knows its session,
// and an internally-generated uuid would be non-deterministic (untestable).
export function emptyChangeset(url: string, createdAt: string, sessionId: string): Changeset {
  return { url, createdAt, sessionId, edits: [] };
}

export function addEdit(changeset: Changeset, edit: Edit): Changeset {
  return { ...changeset, edits: [...changeset.edits, edit] };
}
