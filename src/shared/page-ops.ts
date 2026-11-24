import { z } from 'zod';

// The `pageOp` vocabulary — the answer to "let the agent execute JS on the page" that does not
// execute any JS the agent wrote. Every operation below is code WE bundled; the model chooses an
// `op` name and supplies parameters, exactly like every other tool. No `eval`, no `new Function`,
// no `<script>` injection, nothing a Trusted-Types page can block.
//
// ONE discriminated union behind ONE dispatcher rather than one tool per operation: the whole tool
// surface is re-sent on every step, so composition belongs in parameters
// (../gold-standards-in-ai/docs/ai-agents/tools-and-mcp.md). Adding an operation costs one union
// member and one `case`, never another tool the model has to read past on every turn.
//
// SCHEMA LOCATION: moved here verbatim from `src/dom/page-ops/schema.ts` now that the bus message
// (`PageOpInput` in `./messages.ts`) has landed. It imports nothing but zod, exactly like the other
// shared schema modules, so it is safe in every world — including the MAIN world, which
// `injected.content.ts` evaluates in every frame of every page.
//
// Split by what a design/debug agent cannot get any other way:
//   geometry  — derived layout the DOM does not expose (clipping, stacking, effective visibility)
//   motion    — animation + media control, so a screenshot is deterministic
//   forms     — field state, and writes a framework actually notices
//   page      — the MAIN world: framework internals and page APIs (src/dom/page-main-ops.ts)

/** How deep a value read walks before it stops describing and starts dumping. */
export const MAX_VALUE_DEPTH = 4;
/** Hard cap on any serialized page value, in characters — the result rides the transcript and is
 *  re-sent on every later step. */
export const MAX_VALUE_CHARS = 8_000;
/** Cap on collection results (form fields, animations, storage keys). */
export const MAX_ITEMS = 100;

const selector = z.string().min(1);

// --- geometry -------------------------------------------------------------

export const BoxOp = z.object({
  op: z.literal('box'),
  selector,
});

export const OverflowOp = z.object({
  op: z.literal('overflow'),
  // Omit to audit the whole document for horizontal overflow — the single most common responsive
  // defect, and one no per-element read can find.
  selector: selector.optional(),
});

export const ScrollContainerOp = z.object({
  op: z.literal('scrollContainer'),
  selector,
});

export const StackingOp = z.object({
  op: z.literal('stacking'),
  selector,
});

export const VisibilityOp = z.object({
  op: z.literal('visibility'),
  selector,
});

// --- motion ---------------------------------------------------------------

export const AnimationsOp = z.object({
  op: z.literal('animations'),
  /** Root of the subtree to inspect; omit for the whole document. */
  selector: selector.optional(),
});

export const FreezeMotionOp = z.object({
  op: z.literal('freezeMotion'),
  /** `false` restores the page's own motion. Reversible by construction — the freeze is one
   *  injected rule plus a pause of the live animations, both undone on release. */
  frozen: z.boolean().default(true),
});

export const MediaOp = z.object({
  op: z.literal('media'),
  selector,
  action: z.enum(['pause', 'play', 'mute', 'unmute', 'seek']),
  /** Seconds, for `seek`. */
  time: z.number().nonnegative().optional(),
});

// --- forms ----------------------------------------------------------------

export const FormStateOp = z.object({
  op: z.literal('formState'),
  /** A `<form>`, or any container; omit for the whole document. */
  selector: selector.optional(),
});

export const SetFieldOp = z.object({
  op: z.literal('setField'),
  selector,
  /** Text/number/select value. Exactly one of `value` / `checked` applies per field type. */
  value: z.string().optional(),
  /** Checkbox / radio state. */
  checked: z.boolean().optional(),
});

// --- storage --------------------------------------------------------------

// KEYS AND SIZES ONLY, never values. Web storage is where sites keep session tokens; a values read
// would put a credential into the model transcript, which is then re-sent to the provider on every
// later step of the turn. The key names alone answer the question this op exists for ("does this
// app keep its cart / auth / feature flags client-side, and is the key there?"), and anything more
// specific is better served by the app's own UI. Deliberately not parameterized to opt into values.
export const StorageKeysOp = z.object({
  op: z.literal('storageKeys'),
  area: z.enum(['local', 'session']).default('local'),
});

// --- MAIN world -----------------------------------------------------------

export const FrameworkStateOp = z.object({
  op: z.literal('frameworkState'),
  selector,
});

export const PageValueOp = z.object({
  op: z.literal('pageValue'),
  /** Dotted path from `window` — `__NEXT_DATA__.props.pageProps`, `myApp.store.state`. */
  path: z.string().min(1).max(200),
});

export const PageCallOp = z.object({
  op: z.literal('pageCall'),
  /** Dotted path from `window` to a FUNCTION — `myChart.update`, `app.router.push`. */
  path: z.string().min(1).max(200),
  /** JSON-only arguments. There is no way to pass a function, so no way to pass code. */
  args: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .max(8)
    .default([]),
});

export const FlushOp = z.object({
  op: z.literal('flush'),
});

// --- the page's own design system ----------------------------------------

// Reads the AUTHORED layer (declared custom properties, the page's own media-query breakpoints,
// its font stacks) rather than the rendered one `src/dom/identity.ts` samples. An overhaul that
// redefines `--space-4` changes the page coherently; one that writes `16px` in forty places is a
// mess a developer has to undo. Takes no parameters — it is a whole-page read.
export const DesignSystemOp = z.object({
  op: z.literal('designSystem'),
});

export const PageOp = z.discriminatedUnion('op', [
  BoxOp,
  OverflowOp,
  ScrollContainerOp,
  StackingOp,
  VisibilityOp,
  AnimationsOp,
  FreezeMotionOp,
  MediaOp,
  FormStateOp,
  SetFieldOp,
  StorageKeysOp,
  FrameworkStateOp,
  PageValueOp,
  PageCallOp,
  FlushOp,
  DesignSystemOp,
]);
export type PageOp = z.infer<typeof PageOp>;

/** The ops served by the MAIN world (src/dom/page-main-ops.ts) rather than the isolated content
 *  world — they need the page's own JS realm, which is the entire reason the bridge exists. */
export const MAIN_WORLD_OPS: ReadonlySet<PageOp['op']> = new Set([
  'frameworkState',
  'pageValue',
  'pageCall',
  'flush',
]);
