// The model-facing tool surface: four RESOURCES over the per-verb tools, not forty-seven verbs.
//
// WHY. Every tool definition is re-sent on every step of every turn, and past a few dozen the
// surface stops being a menu and becomes something the model reads past — the observed failure was
// a "modernize this page" turn that fired 21 reads and zero edits, never reaching for `wrapNode` or
// `injectCss` at all. Grouping by RESOURCE (`inspect` / `edit` / `interact` / `session`) puts one
// verb-shaped decision in front of the model — "am I reading, changing, driving, or recording?" —
// and pushes composition into an `op` parameter, which is the shape
// `../gold-standards-in-ai/docs/ai-agents/tools-and-mcp.md` argues for.
//
// A FACADE, NOT A REWRITE. Each resource routes to the SAME per-verb tool objects the loop already
// built (`createDomTools`, `createInteractTools`, …). Nothing about the bus, the dispatches or the
// content script changes, the op schemas are DERIVED from each tool's own `inputSchema` so they
// cannot drift, and every per-verb unit test keeps passing untouched. The per-verb builders are now
// this module's routing layer rather than the model's menu.
//
// THREE PROPERTIES THAT ARE LOAD-BEARING, each of which cost something real when it was missing:
//
//  1. THE OPERATION IS IN THE INPUT. `src/shared/overlay-step.ts` classifies the on-page overlay by
//     reading `op` out of the tool input, precisely so a renamed or regrouped tool cannot change the
//     accent. Every resource here discriminates on a literal `op`, so the overlay keeps naming the
//     real operation (`setStyle → .hero`, not `edit → .hero`).
//  2. `handoff` STAYS TOP-LEVEL. `loop.ts` gates Ship with `toolApproval`, which is keyed by tool
//     NAME; folding `handoff` into a `session` dispatcher would make approval fire on every session
//     call or none. "Never auto-ship" is a hard rule (CLAUDE.md), so it keeps its own tool — about
//     300 characters of schema to preserve the guarantee verbatim.
//  3. ANYTHING UNCLASSIFIED STAYS REACHABLE. {@link RESOURCE_OF} is an allow-list; a tool absent
//     from it is passed through as its own top-level tool rather than dropped. That is what keeps
//     MCP backends (third-party names we can never enumerate) and `invalidTool` (the repair
//     channel) working, and it means a future tool nobody classified degrades to "listed
//     separately" instead of "silently unreachable".

import { type Tool, tool } from 'ai';
import { z } from 'zod';
import { Target } from '@/shared/messages';
import { PageOp } from '@/shared/page-ops';

/** The structural view of a built tool this module needs. Deliberately not the SDK's `Tool` — the
 *  per-verb builders return precisely-typed tools and we only ever read these four members. */
interface BuiltTool {
  readonly description?: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  readonly execute?: (input: unknown, options: unknown) => PromiseLike<unknown> | unknown;
  readonly toModelOutput?: (options: {
    toolCallId: string;
    input: unknown;
    output: unknown;
  }) => unknown;
}

/** A ToolSet as this module consumes it — names to built tools. */
export type NamedTools = Record<string, BuiltTool>;

export const RESOURCE_NAMES = ['inspect', 'edit', 'interact', 'session'] as const;
export type ResourceName = (typeof RESOURCE_NAMES)[number];

/**
 * Which resource each per-verb tool becomes an `op` of. An ALLOW-LIST, not a partition: a tool not
 * named here stays a top-level tool of its own (see property 3 in the header).
 *
 * The split is by the QUESTION the model is answering, not by which module built the tool — reads
 * that cost nothing to repeat, changes that land in the changeset, actions that move the browser,
 * and the durable record. `screenshot`/`responsiveCapture` sit under `inspect` because they answer
 * "what does it look like"; `setDevice` sits under `interact` because it changes browser state.
 */
export const RESOURCE_OF: Readonly<Record<string, ResourceName>> = {
  // --- inspect: reads. Never changes the page; safe to repeat. -------------------------------
  query: 'inspect',
  getStyles: 'inspect',
  a11ySnapshot: 'inspect',
  screenshot: 'inspect',
  responsiveCapture: 'inspect',
  inspectVisually: 'inspect',
  readImages: 'inspect',
  readImageContent: 'inspect',
  describe: 'inspect',
  extractIdentity: 'inspect',
  pageFacts: 'inspect',
  readChart: 'inspect',
  checkResponsive: 'inspect',
  diagnostics: 'inspect',
  browse: 'inspect',
  // --- edit: changes the design and lands in the changeset. ----------------------------------
  setStyle: 'edit',
  setText: 'edit',
  setAttr: 'edit',
  removeAttr: 'edit',
  addClass: 'edit',
  removeClass: 'edit',
  batch: 'edit',
  insertNode: 'edit',
  moveNode: 'edit',
  removeNode: 'edit',
  wrapNode: 'edit',
  unwrapNode: 'edit',
  replaceNode: 'edit',
  injectCss: 'edit',
  // --- interact: moves the browser to reach a state. Changes no design. ----------------------
  click: 'interact',
  type: 'interact',
  hover: 'interact',
  pressKey: 'interact',
  scrollTo: 'interact',
  selectOption: 'interact',
  waitFor: 'interact',
  handleDialog: 'interact',
  widgetAct: 'interact',
  chartTooltip: 'interact',
  navigate: 'interact',
  navigateBack: 'interact',
  reload: 'interact',
  tabs: 'interact',
  frames: 'interact',
  setDevice: 'interact',
  pageOp: 'interact',
  // --- session: the durable record. ----------------------------------------------------------
  recordEdit: 'session',
  undo: 'session',
  redo: 'session',
  discardUndo: 'session',
};

/** Resource-level prose. The per-op detail is appended from each tool's OWN description, so the
 *  routing signal the model needs is never lost to grouping — the one thing context-budget.md says
 *  you must not cut. */
const RESOURCE_BLURB: Readonly<Record<ResourceName, string>> = {
  inspect:
    'READ the page. Nothing here changes anything, so these are safe to repeat — but every result ' +
    'rides your context for the rest of the turn, so ask for the narrowest thing that answers your ' +
    'question. Pick the operation with `op`.',
  edit:
    'CHANGE the page. Every operation here is reversible and is recorded into the changeset that ' +
    'gets shipped, so `intent` is REQUIRED: say what you are trying to achieve, not what you are ' +
    'typing — it becomes the WHY in the handoff brief, and two changes that share an intent are ' +
    'recognised as one piece of work. For a broad redesign reach for `injectCss` (a real ' +
    'stylesheet, the only way to write media queries) and `wrapNode` (the restructuring ' +
    'primitive) before a long run of per-element `setStyle`. Pick the operation with `op`.',
  interact:
    'DRIVE the browser — reach a state, do not design it. Clicking, typing, waiting, navigating, ' +
    'switching tabs or frames, emulating a device, and the bundled page operations (derived ' +
    'layout, motion and form control). None of this changes the design or is recorded as an edit. ' +
    'Pick the operation with `op`.',
  session:
    'The durable RECORD of this session: record an accepted change, or walk it back. Pick the ' +
    'operation with `op`.',
};

const PAGE_OP_NAMES: ReadonlySet<string> = new Set(
  PageOp.options.map((member) => {
    const shape = (member as unknown as z.ZodObject<z.ZodRawShape>).shape;
    const literal = shape.op as unknown as { value?: unknown };
    return String(literal?.value ?? '');
  }),
);

/** One line per operation, so the model can route without a second round-trip. The catalogue is
 *  INLINE deliberately: a `describe_resource` step would buy a step on a surface this small, and a
 *  capability the model cannot discover reads to it as impossible. */
function opCatalogue(ops: ReadonlyMap<string, BuiltTool>): string {
  const lines: string[] = [];
  for (const [op, built] of ops) {
    const description = (built.description ?? '').replace(/\s+/g, ' ').trim();
    if (op === 'pageOp') {
      // Its members are flattened into this resource, so list THEM — listing `pageOp` would name an
      // operation the model cannot call and hide the ones it can.
      lines.push(`- ${[...PAGE_OP_NAMES].map((n) => `\`${n}\``).join(', ')} — ${description}`);
      continue;
    }
    lines.push(`- \`${op}\` — ${description}`);
  }
  return lines.join('\n');
}

/** `intent`, required — the model-facing half of the bus's optional field. An intentless changeset
 *  is impossible to produce through the agent even though the bus would accept one. */
const RequiredIntent = z.object({
  intent: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'What this change is FOR, in your own words — the WHY that goes into the handoff brief. ' +
        'Not a restatement of the CSS.',
    ),
});

/**
 * The op member for one per-verb tool: its own input schema plus the `op` literal that selects it.
 * DERIVED, never re-declared, so a change to a tool's schema reaches the resource automatically.
 * `edit` ops additionally require `intent`.
 */
function opMember(
  op: string,
  built: BuiltTool,
  resource: ResourceName,
): z.ZodObject<z.ZodRawShape> {
  const base = built.inputSchema.extend({ op: z.literal(op) });
  return resource === 'edit' ? base.extend(RequiredIntent.shape) : base;
}

/** The `pageOp` members, flattened into `interact` as first-class ops rather than nested behind a
 *  second dispatcher — the model should not have to know that derived-layout reads happen to share
 *  a transport. They already discriminate on `op`, so they slot straight in. */
function pageOpMembers(): z.ZodObject<z.ZodRawShape>[] {
  // `...Target.shape` is NOT optional here. `PageOp`'s members carry only their own parameters —
  // tab/frame addressing lives on the `PageOpInput` WRAPPER that this flattening removes. Without
  // re-adding it, Zod strips `tabId`/`frameId` as unknown keys (objects strip, they do not throw),
  // and every flattened page op silently becomes un-addressable: it would always run against the
  // turn's default tab and top frame, so an overflow audit of an iframe or a reference tab would
  // quietly report on the wrong document.
  return (PageOp.options as unknown as z.ZodObject<z.ZodRawShape>[]).map((member) =>
    member.extend(Target.shape),
  );
}

/** A tool result for a call this resource cannot route. Total by construction — a malformed `op`
 *  costs one result the model can react to, never the turn. */
const unknownOp = (op: string, resource: string): unknown => ({
  type: 'tool-result',
  ok: false,
  error: `\`${op}\` is not an operation of \`${resource}\`. Check the operation list in this tool's description.`,
});

/**
 * Build the model-facing ToolSet from the per-verb tools.
 *
 * Returns the four resources plus every tool {@link RESOURCE_OF} does not claim, passed through
 * unchanged — `handoff` (Ship's approval gate keys on that exact name), `invalidTool` (the repair
 * channel), and every MCP backend tool.
 */
export function createResourceTools(tools: NamedTools): Record<string, Tool> {
  const grouped = new Map<ResourceName, Map<string, BuiltTool>>(
    RESOURCE_NAMES.map((name) => [name, new Map<string, BuiltTool>()]),
  );
  const passthrough: Record<string, Tool> = {};

  for (const [name, built] of Object.entries(tools)) {
    const resource = RESOURCE_OF[name];
    if (resource) grouped.get(resource)?.set(name, built);
    else passthrough[name] = built as unknown as Tool;
  }

  const out: Record<string, Tool> = { ...passthrough };
  for (const resource of RESOURCE_NAMES) {
    const ops = grouped.get(resource);
    // A resource whose dispatches were all absent this turn (e.g. no `browse` dispatch injected)
    // is simply not offered, rather than offered empty.
    if (!ops || ops.size === 0) continue;
    out[resource] = buildResource(resource, ops);
  }
  return out;
}

function buildResource(resource: ResourceName, ops: Map<string, BuiltTool>): Tool {
  // `pageOp` contributes its NESTED union flattened into this resource instead of itself, so the
  // model picks `overflow` directly rather than `pageOp` and then an inner op.
  const members = [...ops]
    .filter(([op]) => op !== 'pageOp')
    .map(([op, built]) => opMember(op, built, resource));
  const all = [...members, ...(ops.has('pageOp') ? pageOpMembers() : [])];

  const catalogue = opCatalogue(ops);
  const description = `${RESOURCE_BLURB[resource]}\n\nOperations:\n${catalogue}`;

  return tool({
    description,
    // `as never` only because Zod's discriminated-union overload cannot see that a runtime-built
    // array is non-empty; every member is a ZodObject with an `op` literal by construction.
    inputSchema: z.discriminatedUnion('op', all as never),
    execute: async (input: unknown, options: unknown) => {
      const record = (input ?? {}) as Record<string, unknown>;
      const op = String(record.op ?? '');
      const { op: _op, ...params } = record;

      // A flattened page op is re-nested onto the `pageOp` tool, which owns that transport.
      if (PAGE_OP_NAMES.has(op)) {
        const pageOp = ops.get('pageOp');
        if (!pageOp?.execute) return unknownOp(op, resource);
        const { tabId, frameId, ...rest } = params as Record<string, unknown>;
        return pageOp.execute(
          {
            op: { op, ...rest },
            ...(tabId !== undefined ? { tabId } : {}),
            ...(frameId !== undefined ? { frameId } : {}),
          },
          options,
        );
      }

      const target = ops.get(op);
      if (!target?.execute) return unknownOp(op, resource);
      // `intent` is the resource's own field on `edit`; the bus accepts it too (it rides the
      // mutation message so the recorder can fold it into the durable Edit), so it passes straight
      // through rather than being stripped here.
      return target.execute(params, options);
    },
    // Dispatch the model-output hook by op, so `screenshot`/`responsiveCapture` still come back as
    // VISION parts rather than JSON. Losing this would silently end the self-correction loop — the
    // agent would stop being able to see its own work.
    toModelOutput: ({ toolCallId, input, output }) => {
      const op = String(((input ?? {}) as Record<string, unknown>).op ?? '');
      const hook = ops.get(op)?.toModelOutput;
      if (hook) return hook({ toolCallId, input, output }) as never;
      return { type: 'json', value: output } as never;
    },
  }) as unknown as Tool;
}
