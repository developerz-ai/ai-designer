// Pure mapping from an agent tool call to the on-page overlay's step info (slice 09). Lives in
// src/shared (not src/agent or src/dom) so it has zero chrome.*/DOM deps: `agent/loop.ts` (SW)
// calls `classifyTool` to enrich the `tool-call` stream event, and `background.ts`'s
// `forwardOverlayStep` calls `overlayLabel` to compose the on-page card's text from that same
// event — one source of truth for both, easy to unit-test in isolation.
//
// CLASSIFY ON THE OPERATION, NOT THE TOOL NAME. This used to be a set of tool NAMES, which made it
// silently wrong in two ways that both matter more than they look:
//
//   • A dispatcher-shaped tool (`batch` today; a consolidated `edit`/`interact` resource tomorrow)
//     is not in a name list, so every mutation it carried rendered in the READ accent and lost its
//     target highlight. Nothing throws — the overlay just quietly lies about what the agent is
//     doing to the user's page, which is the worst failure mode available to a feature whose entire
//     job is showing the user what is happening.
//   • The label read `batch → undefined` instead of naming the actual change.
//
// The fix is to read the OPERATION out of the input — `op`, or the first entry of `ops[]` — and
// classify on that. The operation vocabulary is the bus vocabulary (`DomTool`/`ControlTool`
// `type`s), which is stable regardless of how the model-facing tool surface is grouped or renamed.
// The tool-name set remains as the fallback for calls that carry no operation of their own (the
// per-verb built-ins, and MCP tools, which keep their own names forever).

/** Cosmetic accent — `read`/`info` outline in indigo (the picker's hover color), `act` in emerald
 *  (its committed-selection color). Mirrors `src/dom/overlay.ts`'s `OverlayStepKind` without
 *  importing it (dom/ imports FROM shared/, never the reverse). */
export type OverlayStepKind = 'read' | 'act' | 'info';

// Operations that CHANGE the page — the bus `type` vocabulary, covering the design mutations
// (src/dom/mutate.ts), the page drivers (interact.ts), widgets.ts's widgetAct, and the session
// recorder. Everything not named here is a read when it targets an element, else info.
//
// Kept as literal sets rather than derived from the `DomTool` union: the union also holds the
// reads, and a new operation must be classified DELIBERATELY — an unclassified mutation silently
// defaults to the read accent, which is exactly the defect this module exists to prevent.
//
// EXPORTED as the ONE registration point for this vocabulary. The panel's turn-phase derivation
// (`src/entrypoints/sidepanel/components/chat/turn-phase.ts`) used to hand-copy these names into
// its own reading/editing sets; a mutation added here and forgotten there silently rendered as a
// read in the working line. Panel consumers derive, never re-list.

/** Design mutations — they land in the changeset. The `edit` resource's ops, exactly
 *  (`agent/tools/resources.ts` `RESOURCE_OF`, guarded by resources.test.ts). */
export const EDIT_OPS: ReadonlySet<string> = new Set([
  'setStyle',
  'setText',
  'setAttr',
  'removeAttr',
  'addClass',
  'removeClass',
  'insertNode',
  'moveNode',
  'removeNode',
  'wrapNode',
  'unwrapNode',
  'replaceNode',
  'injectCss',
  'batch',
]);

/** Page drivers — they move the browser to reach a state, changing no design. */
export const DRIVE_OPS: ReadonlySet<string> = new Set([
  'click',
  'type',
  'pressKey',
  'hover',
  'selectOption',
  'scrollTo',
  'widgetAct',
  'setDevice',
]);

/** The durable-record verbs — they mutate the changeset, not the page's design directly. */
export const RECORD_OPS: ReadonlySet<string> = new Set([
  'recordEdit',
  'undo',
  'redo',
  'discardUndo',
]);

/** Everything that ACTS (the overlay's emerald accent): the union of the three sets above plus
 *  the acting page ops. Same membership the old private literal set had. */
export const ACT_OPS: ReadonlySet<string> = new Set([...EDIT_OPS, ...DRIVE_OPS, ...RECORD_OPS]);

/** Page operations (`pageOp`) that act rather than read. Most of the `PageOp` union is derived
 *  layout — pure reads — but motion/media/form/page-function control drives the page. Names are
 *  the REAL `PageOp` discriminants (`src/shared/page-ops.ts`): the previous list carried
 *  `setFieldValue`/`submitForm`/`focusField`, operations that do not exist, so `setField`,
 *  `pageCall` and `flush` all rendered in the read accent. Exported with the sets above —
 *  turn-phase.ts derives from these too. */
export const ACT_PAGE_OPS: ReadonlySet<string> = new Set([
  'freezeMotion',
  'media',
  'setField',
  'pageCall',
  'flush',
]);

/** Tools whose INPUT names the operation: the grouped resources plus dispatcher-shaped per-verb
 *  tools. Everything else — MCP backends above all — owns its name; reading a stray `type` field
 *  off a third-party input labelled an `acme__task` call "bug" in the chip, overlay, log and
 *  rehydrated thread. */
export const DISPATCHER_TOOLS: ReadonlySet<string> = new Set([
  'inspect',
  'edit',
  'interact',
  'session',
  'pageOp',
  'batch',
]);

/** Does this operation ACT on the page (design mutation, driver, record verb, or an acting page
 *  op)? One answer for the overlay accent here and the panel's phase fallback (turn-phase.ts). */
export function isActOperation(operation: string): boolean {
  return ACT_OPS.has(operation) || ACT_PAGE_OPS.has(operation);
}

export interface ToolCallClassification {
  selector?: string;
  kind: OverlayStepKind;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(source: Record<string, unknown> | null, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** The FIRST entry of an `ops[]` array, when the input is dispatcher-shaped (`batch`, and any
 *  consolidated resource). One op is enough: the overlay shows a single current action, and a batch
 *  is one user-visible step whose first target is the one worth highlighting. */
function firstOp(input: Record<string, unknown> | null): Record<string, unknown> | null {
  const ops = input?.ops;
  return Array.isArray(ops) ? asRecord(ops[0]) : null;
}

/**
 * The operation this call performs, independent of how the tool surface is grouped: an explicit
 * `op`/`type` on the input, else the first batched op's `type`/`op`, else `undefined` for a
 * per-verb tool that carries no operation of its own.
 *
 * When the caller names the tool, only a DISPATCHER's input is read (`DISPATCHER_TOOLS`): a
 * third-party (MCP) tool's input can carry an `op`/`type` field of its own vocabulary, and
 * reading it relabelled the call everywhere the operation is shown. Callers that predate the
 * gate (no `toolName`) keep the old behaviour.
 */
export function operationOf(input: unknown, toolName?: string): string | undefined {
  if (toolName !== undefined && !DISPATCHER_TOOLS.has(toolName)) return undefined;
  const record = asRecord(input);
  const direct = stringField(record, 'op') ?? stringField(record, 'type');
  if (direct) return direct;
  const op = firstOp(record);
  return stringField(op, 'type') ?? stringField(op, 'op');
}

/** The element this call targets: the input's own `selector`, else the first batched op's, else the
 *  one nested under a dispatcher's `params`. */
function selectorOf(input: unknown): string | undefined {
  const record = asRecord(input);
  return (
    stringField(record, 'selector') ??
    stringField(firstOp(record), 'selector') ??
    stringField(asRecord(record?.params), 'selector')
  );
}

/** Classify one tool call for the overlay: the element it targets (when its input names one) +
 *  a cosmetic read/act/info accent. Operation-first, tool-name as fallback. */
export function classifyTool(tool: string, input: unknown): ToolCallClassification {
  const selector = selectorOf(input);
  const operation = operationOf(input, tool);
  const acts = operation !== undefined ? isActOperation(operation) : ACT_OPS.has(tool);
  const kind: OverlayStepKind = acts ? 'act' : selector ? 'read' : 'info';
  return selector ? { selector, kind } : { kind };
}

/** Human-legible current-action label, e.g. `setStyle → .hero` or a bare `navigate` when there's
 *  no target selector. Prefers the OPERATION over the tool name — under a grouped tool surface
 *  `edit → .hero` says far less than `setStyle → .hero`, and the operation is what the user is
 *  actually watching happen. */
export function overlayLabel(tool: string, selector?: string, input?: unknown): string {
  const name = (input !== undefined ? operationOf(input, tool) : undefined) ?? tool;
  return selector ? `${name} → ${selector}` : name;
}
