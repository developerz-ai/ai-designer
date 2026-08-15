// WHAT THE AGENT IS DOING RIGHT NOW, derived from the turn's tool calls. Pure — no Solid, no
// `chrome.*`, no store import — so the derivation is unit-testable without mounting anything, and
// `Message.tsx` stays render + dispatch only (CLAUDE.md "SolidJS + SRP": no business logic in
// components).
//
// WHY THIS EXISTS. The working line was one hardcoded string, `message.working` = "Editing the
// page…", shown from send until the first token. It was FALSE for most of the wait: every turn
// READS first (`pageFacts` / `describe` / `screenshot`), so the panel claimed to be changing a page
// it had not touched — alarming when the user asked a question rather than for an edit, and useless
// as progress. And the gap it covers is real and visible: the first turn pays provider setup,
// content-script injection and the opening page reads before a single token lands, and a user
// watching one frozen sentence for several seconds reasonably concludes the panel has hung. The
// latency cannot be removed, so the wait is made INFORMATIVE instead.
//
// TWO SHAPES OF `tool`, BOTH REAL. The model-facing surface is GROUPED (`src/agent/tools/
// resources.ts`): the model calls `inspect` / `edit` / `interact` / `session` and names the real
// operation in the input. `loop.ts` resolves it at the emit site (`operationOf(part.input) ??
// part.toolName`), so the panel usually receives the per-verb name (`setStyle`) — but a call that
// carries no `op` of its own still arrives as the RESOURCE name. Classifying on only one of the two
// would have left half the calls unclassified, so both are handled: `edit` maps to editing,
// `inspect` to reading.
//
// HONESTY IS THE POINT. An unrecognised call never guesses "editing" — it falls back to the
// `kind` the service worker already classified, and then to a generic "Working…". Claiming a
// mutation that did not happen is the exact defect this module was written to remove.

import { EDIT_OPS } from '@/shared/overlay-step';

/** The phases a turn is observably in. One per i18n line — see {@link PHASE_KEY}. */
export type TurnPhase =
  | 'starting'
  | 'reading'
  | 'looking'
  | 'editing'
  | 'thinking'
  | 'shipping'
  | 'working';

/** The structural view of one tool call this module needs. Deliberately NOT the store's
 *  `ToolCallEntry` (mirrors `resources.ts`'s `BuiltTool`): a pure derivation must not couple the
 *  component tree's data shape to a store module, and these two members are all it reads. */
export interface PhaseCall {
  readonly tool: string;
  readonly kind?: 'read' | 'act' | 'info';
}

/** Reads that answer "what does it look like" by LOOKING — capture and vision. Their own phase
 *  because they are slow, visible and distinct: a screenshot round-trip is one of the longest
 *  single steps in a turn, and "Reading the page…" for eight seconds of capture reads as a stall. */
const LOOKING_TOOLS: ReadonlySet<string> = new Set([
  'screenshot',
  'responsiveCapture',
  'inspectVisually',
  'readImages',
  'readImageContent',
]);

/** Reads that change nothing — the `inspect` resource and every per-verb op under it (minus the
 *  vision ones above, which get `looking`). */
const READING_TOOLS: ReadonlySet<string> = new Set([
  'inspect', // the grouped resource name, for a call that carries no `op`
  'query',
  'getStyles',
  'a11ySnapshot',
  'describe',
  'pageFacts',
  'diagnostics',
  'readChart',
  'checkResponsive',
  'browse',
  'extractIdentity',
]);

/** Design mutations — the `edit` resource and its ops, DERIVED from the shared vocabulary
 *  (`shared/overlay-step.ts` `EDIT_OPS`, itself pinned to `resources.ts` by resources.test.ts) so a
 *  new mutation classifies here the moment it exists, instead of drifting behind a third
 *  hand-maintained copy. Only the grouped resource name is panel-local: overlay-step classifies
 *  operations, and `edit` is the name a call arrives under when it carries no `op` of its own. */
const EDITING_TOOLS: ReadonlySet<string> = new Set(['edit', ...EDIT_OPS]);

/** Handing the changeset over. Stays a top-level tool by name (never folded into a resource) so
 *  that `loop.ts`'s ship approval can key on it — see `resources.ts` property 2. */
const SHIPPING_TOOL = 'handoff';

/**
 * The phase a turn is in, from its tool calls so far.
 *
 * THE LATEST CALL DECIDES, because that is what is happening NOW — the line is a progress
 * indicator, not a summary. NO CALLS YET means `starting`: that is the first-message gap, the exact
 * moment the old copy claimed an edit, and the one case where the honest answer is "getting ready".
 */
export function turnPhase(calls: readonly PhaseCall[] | undefined): TurnPhase {
  const latest = calls?.at(-1);
  if (!latest) return 'starting';
  const tool = latest.tool;
  if (tool === SHIPPING_TOOL) return 'shipping';
  if (LOOKING_TOOLS.has(tool)) return 'looking';
  if (READING_TOOLS.has(tool)) return 'reading';
  if (EDITING_TOOLS.has(tool)) return 'editing';
  // Unrecognised name — an interact/session op, an MCP backend's own tool, or a verb added since.
  // Fall back to the kind the SW already classified (`shared/overlay-step.ts`), which is derived
  // from the operation rather than the name and so survives regrouping.
  switch (latest.kind) {
    case 'read':
      return 'reading';
    case 'act':
      return 'editing';
    case 'info':
      return 'thinking';
    default:
      // Nothing at all is known about this call. Say the vague true thing.
      return 'working';
  }
}

/** Phase → i18n line. `working` is the pre-existing generic ("Working…"); every other phase says
 *  what is actually happening. Literal types, so `i18n.t` still type-checks the keys. */
export const PHASE_KEY = {
  starting: 'message.phase.starting',
  reading: 'message.phase.reading',
  looking: 'message.phase.looking',
  editing: 'message.phase.editing',
  thinking: 'message.phase.thinking',
  shipping: 'message.phase.shipping',
  working: 'message.working',
} as const satisfies Record<TurnPhase, string>;

export type PhaseKey = (typeof PHASE_KEY)[TurnPhase];

/** The i18n key for the working line of a turn with these tool calls — the one entry point
 *  `Message.tsx` needs, so the component composes nothing. */
export function workingPhaseKey(calls: readonly PhaseCall[] | undefined): PhaseKey {
  return PHASE_KEY[turnPhase(calls)];
}
