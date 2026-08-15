// DOM tools for the agent loop — one AI SDK `tool()` per `DomTool` member, derived 1:1
// from the Zod input consts in `src/shared/messages.ts`. Add a DOM tool = add a const + a
// union entry there, then one line here: the tool NAME is the schema's `type` discriminant
// and the `inputSchema` is that const minus `type` (the model never supplies the
// discriminant — the tool name carries it), so the two can never drift.
//
// SW-ONLY. `execute` is a bus round-trip: it reassembles the `DomTool` message and hands it
// to an injected `DomDispatch`, which `chrome.tabs.sendMessage`s it to the content script
// (the only world with DOM) and resolves the typed `ToolResult`. Dispatch is injected (not
// performed here) so this module stays chrome-free + unit-testable and turn-scoped to one
// tab; the real transport is wired in the agent loop (slice 04, `src/agent/loop.ts`). Until
// the content script is real (slice 05) these calls drive its stubs.

import { tool } from 'ai';
import { z } from 'zod';
import {
  A11ySnapshotInput,
  AddClassInput,
  BatchInput,
  BulkStructuralInput,
  DiagnosticsInput,
  DiscardUndoInput,
  type DomTool,
  InjectCssInput,
  InsertNodeInput,
  MoveNodeInput,
  PageOpInput,
  QueryInput,
  RemoveAttrInput,
  RemoveClassInput,
  RemoveNodeInput,
  ReplaceNodeInput,
  ScreenshotInput,
  SetAttrInput,
  SetStyleInput,
  SetTextInput,
  Target,
  ToolResult,
  UndoInput,
  UnwrapNodeInput,
  WrapNodeInput,
} from '@/shared/messages';

// --- multi-target `getStyles` -----------------------------------------------------------------
//
// THE DEFECT THIS CLOSES (measured, HN session 2026-08-14): a "make the page more modern" turn
// spent its entire 200k token budget on 21 read calls and made zero edits. Eleven of those were
// `getStyles`, one per element, because `getStyles` took exactly ONE `selector` — there was no
// multi-target read anywhere in the system. `batch` (below) is mutations only (`BatchOp` in
// src/shared/messages.ts), so the model was not ignoring a batching path; it was following the
// system prompt's "batch independent calls in one step" the only way the API allowed, by firing a
// wide fan-out of single-target calls. Each returned all 22 properties whether or not they were
// wanted.
//
// Both halves are fixed HERE, in the tool layer, with NO bus change:
//   • `selectors[]` fans out to N existing `{type:'getStyles'}` messages in parallel and merges.
//   • `props[]` projects the returned map down to what was asked for. `src/dom/read.ts` has
//     supported a `props` argument since it was written, but `GetStylesInput` never exposed it —
//     so the projection happens SW-side instead. The content payload is unchanged; what reaches
//     the MODEL (and therefore the transcript, re-sent every step) is not.
//
// Deliberately additive: `selector` still works, so nothing that already calls this breaks.

/** What the MODEL sees — deliberately NOT `GetStylesInput`, which the rest of this file derives
 *  1:1 from the bus. The bus stays single-target; only the model-facing surface batches. */
const GetStylesMultiInput = z.object({
  /** One element. Kept for back-compat and for the genuinely single-target case. */
  selector: z.string().optional(),
  /** Many elements in one round-trip — the form to reach for. Bounded because every result rides
   *  the transcript on every later step; 20 covers a whole page section's worth of elements. */
  selectors: z.array(z.string()).min(1).max(20).optional(),
  /** Project the result to these CSS properties. Omitted ⇒ all 22 design-relevant ones. */
  props: z.array(z.string()).min(1).max(40).optional(),
  ...Target.shape,
});
type GetStylesMultiInput = z.infer<typeof GetStylesMultiInput>;

/** Read the `styles` map off one `getStyles` ToolResult, defensively — `ToolResult.data` is
 *  `unknown` on the bus, so its shape is narrowed rather than trusted. */
function stylesOf(result: ToolResult): Record<string, string> | null {
  if (!result.ok || typeof result.data !== 'object' || result.data === null) return null;
  const { styles } = result.data as { styles?: unknown };
  if (typeof styles !== 'object' || styles === null) return null;
  const out: Record<string, string> = {};
  for (const [prop, value] of Object.entries(styles)) {
    if (typeof value === 'string') out[prop] = value;
  }
  return out;
}

/** Keep only `props`, in the order the caller asked for them. An unknown property is simply
 *  absent — never an error, and never a silent substitution of something else. */
function project(
  styles: Record<string, string>,
  props?: readonly string[],
): Record<string, string> {
  if (!props || props.length === 0) return styles;
  const out: Record<string, string> = {};
  for (const prop of props) {
    const value = styles[prop];
    if (value !== undefined) out[prop] = value;
  }
  return out;
}

/**
 * Fan one model-facing `getStyles` call out to one bus message per selector, in parallel, and merge
 * the results into a single map keyed by the selector the model passed (so it can correlate without
 * counting positions). Per-element failures land in `failed` rather than failing the whole call —
 * one bad selector out of eleven must not cost the other ten.
 *
 * Total: a call naming neither `selector` nor `selectors` returns a named error rather than
 * throwing, so a malformed call costs one result, not the turn.
 */
async function getStylesMulti(
  dispatch: DomDispatch,
  input: GetStylesMultiInput,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { selector, selectors, props, ...target } = input;
  const targets = [...new Set([...(selectors ?? []), ...(selector ? [selector] : [])])];
  if (targets.length === 0) {
    return {
      type: 'tool-result',
      ok: false,
      error: 'getStyles needs `selectors` (an array, preferred) or a single `selector`.',
    };
  }

  const results = await Promise.all(
    targets.map((one) => dispatch({ type: 'getStyles', selector: one, ...target }, signal)),
  );

  const styles: Record<string, Record<string, string>> = {};
  const failed: Record<string, string> = {};
  targets.forEach((one, index) => {
    const result = results[index];
    const read = result ? stylesOf(result) : null;
    if (read) styles[one] = project(read, props);
    else failed[one] = result?.error ?? 'no element matched this selector';
  });

  return {
    type: 'tool-result',
    // Any element read is a useful result; only a total miss is a failure.
    ok: Object.keys(styles).length > 0,
    data: { styles, ...(Object.keys(failed).length > 0 ? { failed } : {}) },
    ...(Object.keys(styles).length === 0
      ? { error: 'None of the selectors matched an element.' }
      : {}),
  };
}

/** Round-trips one `DomTool` call to the content script and resolves its `ToolResult`.
 *  Turn-scoped (the caller binds it to the active tab). Implemented in the agent loop with
 *  `chrome.tabs.sendMessage`; injected here so the DOM tools stay chrome-free and testable. */
export type DomDispatch = (msg: DomTool, signal?: AbortSignal) => Promise<ToolResult>;

/**
 * Build the DOM `ToolSet` for one turn. Every `execute` proxies to `dispatch`; the result is
 * keyed by each tool's name (its `DomTool.type`), so it merges straight into the agent's
 * tools alongside the session + MCP tools (slice 04). The concrete return type (not a widened
 * `ToolSet`) keeps each tool addressable by name for consumers and tests.
 */
export function createDomTools(dispatch: DomDispatch) {
  return {
    query: tool({
      description:
        'Resolve a CSS selector to its matching element(s) and return a stable, ' +
        'fragility-scored selector for each. ToolResult.data = { matches: StableSelector[] }. ' +
        'Confirm your target with this before mutating.',
      inputSchema: QueryInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'query', ...input }, abortSignal),
    }),
    getStyles: tool({
      description:
        'Read computed styles for ONE OR MANY elements in a single call. Pass `selectors` (an ' +
        'array) whenever you want more than one element — reading eleven elements is ONE call ' +
        'with eleven selectors, never eleven calls. Pass `props` to get only the properties you ' +
        'actually need (e.g. ["color","background-color"]); omit it and you get all 22 ' +
        'design-relevant properties for every element, which is the single easiest way to fill ' +
        'your context with values you will not read. ToolResult.data = ' +
        '{ styles: Record<selector, Record<prop, value>>, failed?: Record<selector, error> }. ' +
        'Far cheaper than a screenshot for checking current color, spacing, or typography.',
      inputSchema: GetStylesMultiInput,
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => getStylesMulti(dispatch, input, abortSignal),
    }),
    screenshot: tool({
      description:
        'Capture a PNG of the element matching `selector`, or the whole viewport when ' +
        'omitted. ToolResult.data = a base64 PNG. Use it to visually verify a change and ' +
        'self-correct.',
      inputSchema: ScreenshotInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'screenshot', ...input }, abortSignal),
    }),
    a11ySnapshot: tool({
      description:
        'Return the accessibility role/name tree rooted at `selector`. ' +
        'ToolResult.data = { tree: A11yNode }. Cheaper than a screenshot for understanding ' +
        'structure, labels, and hierarchy — but it is the LARGEST read available and it grows ' +
        'with the subtree, so scope `selector` to the region you are working on. Rooting it at ' +
        'the whole document on a content-heavy page can return tens of thousands of characters, ' +
        'which then ride your context for the rest of the turn and get clipped.',
      inputSchema: A11ySnapshotInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) =>
        dispatch({ type: 'a11ySnapshot', ...input }, abortSignal),
    }),
    setStyle: tool({
      description:
        'Apply CSS properties (prop -> value) to the element(s) matching `selector`. ' +
        'Reversible and recorded as an edit. ToolResult.data = the resulting computed subset. ' +
        'Write the RULE, not a measurement: `margin: 0 auto` to centre, never a pixel margin ' +
        'computed from the current window width; prefer tokens, `rem`, `%`, flex/grid/`gap`, ' +
        '`clamp()` and `auto` over a number you read off `getStyles`. A transcribed computed ' +
        'value is correct at exactly one viewport and breaks at every other.',
      inputSchema: SetStyleInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'setStyle', ...input }, abortSignal),
    }),
    batch: tool({
      description:
        'Apply up to 20 property-level mutations in ONE call — `ops` is an ordered list of ' +
        '`setStyle` / `setText` / `setAttr` / `addClass` / `removeClass` objects, each with its ' +
        'own `selector`. Prefer this whenever you are making more than one change you already ' +
        'know: it is one round-trip instead of one per mutation. Each op is recorded as its own ' +
        'reversible edit. ToolResult.data = { applied, failed, results: [{ index, type, ok }] }; ' +
        'on failure the applied ops are ALREADY LIVE — fix only the named indices, do not re-send ' +
        'the whole batch. Structural changes (insertNode/moveNode/removeNode) are not batchable: ' +
        'each one moves the anchors the later ops were written against. To apply ONE structural ' +
        'operation to MANY targets, use `bulkStructural` instead.',
      inputSchema: BatchInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'batch', ...input }, abortSignal),
    }),
    setText: tool({
      description:
        'Replace the visible text content of the element matching `selector`. Target a leaf — ' +
        'it is refused on an element that has child elements (it would delete the subtree). ' +
        'Reversible and recorded as an edit.',
      inputSchema: SetTextInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'setText', ...input }, abortSignal),
    }),
    setAttr: tool({
      description:
        'Set attribute `name` to `value` on the element matching `selector`. Reversible and ' +
        'recorded as an edit. Unsafe writes are refused (on* handlers, src, javascript: URLs).',
      inputSchema: SetAttrInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'setAttr', ...input }, abortSignal),
    }),
    addClass: tool({
      description:
        'Add CSS class `name` to the element matching `selector` (no-op if already present). ' +
        'Reversible and recorded as an edit.',
      inputSchema: AddClassInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'addClass', ...input }, abortSignal),
    }),
    removeClass: tool({
      description:
        'Remove CSS class `name` from the element matching `selector` (no-op if absent). ' +
        'Reversible and recorded as an edit.',
      inputSchema: RemoveClassInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'removeClass', ...input }, abortSignal),
    }),
    insertNode: tool({
      description:
        'Insert agent-authored `html` relative to the element matching `selector` ' +
        '(`position`: beforeend = last child, the default; afterbegin = first child; ' +
        'beforebegin/afterend = as its sibling). Multi-node markup and bare text both work; ' +
        'inline event handlers are stripped. Reversible and recorded as an edit — record it ' +
        "with recordEdit's `structural` field.",
      inputSchema: InsertNodeInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'insertNode', ...input }, abortSignal),
    }),
    moveNode: tool({
      description:
        'Move the element matching `selector` relative to the element matching `refSelector` ' +
        '(same `position` vocabulary as insertNode). Node identity, listeners, and state move ' +
        'with it; undo restores the original parent + next-sibling anchor. Reversible and ' +
        "recorded as an edit — record it with recordEdit's `structural` field.",
      inputSchema: MoveNodeInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'moveNode', ...input }, abortSignal),
    }),
    removeNode: tool({
      description:
        'Remove the element matching `selector` from the page. The node is clipboard-retained, ' +
        'so undo re-inserts the SAME node (listeners and state intact) at its original anchor. ' +
        "Reversible and recorded as an edit — record it with recordEdit's `structural` field.",
      inputSchema: RemoveNodeInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'removeNode', ...input }, abortSignal),
    }),
    removeAttr: tool({
      description:
        'Remove attribute `name` from the element matching `selector`. Distinct from setting it ' +
        'empty: `href=""` is a live link to the current page and `alt=""` means "decorative ' +
        'image" — neither is the same as the attribute being absent. Reversible and recorded.',
      inputSchema: RemoveAttrInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'removeAttr', ...input }, abortSignal),
    }),
    wrapNode: tool({
      description:
        'Wrap the element matching `selector` — or the RANGE from `selector` to `endSelector`, ' +
        "which must be siblings — in `html`. The wrapper markup's deepest single element " +
        'receives the wrapped nodes. This is the restructuring primitive for an overhaul: it is ' +
        'how a loose run of siblings becomes something you can centre, grid, or turn into a card. ' +
        'Do NOT compose it from insertNode + moveNode — that produces two undo entries whose ' +
        "second anchor is the first one's output. Reversible and recorded as one edit.",
      inputSchema: WrapNodeInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'wrapNode', ...input }, abortSignal),
    }),
    unwrapNode: tool({
      description:
        'Replace the element matching `selector` with its own children — the inverse of ' +
        'wrapNode, and how a redundant layout wrapper is removed WITHOUT deleting the content ' +
        'inside it. Reversible and recorded as one edit.',
      inputSchema: UnwrapNodeInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'unwrapNode', ...input }, abortSignal),
    }),
    replaceNode: tool({
      description:
        'Swap the element matching `selector` for `html`, keeping its position. Prefer this over ' +
        'removeNode + insertNode: one undo entry, and the anchor cannot drift between the two ' +
        'halves. Reversible and recorded as one edit.',
      inputSchema: ReplaceNodeInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'replaceNode', ...input }, abortSignal),
    }),
    bulkStructural: tool({
      description:
        'Apply ONE structural operation to EVERY element matching `selector`, in a single call — ' +
        '"remove these 12 spacer rows" is one bulkStructural, never 12 removeNode calls. ' +
        '`action`: `remove`, `unwrap`, `wrap` (needs `html`), `replace` (needs `html`), or ' +
        '`removeAttr` (needs `name`). Targets are resolved ONCE, before anything is touched, and ' +
        'the call is capped at 50 matches — over the cap NOTHING is applied and the error says ' +
        'so. A target that left the document earlier in the same call (an earlier target ' +
        'contained it) is skipped and named. Every applied element is recorded as its OWN ' +
        'reversible edit, so undo steps back one element at a time. ToolResult.data = ' +
        '{ applied, failed, results: [{ index, selector, ok }] }; on partial failure the applied ' +
        'ops are ALREADY LIVE — fix only the named targets, never re-send the call.',
      inputSchema: BulkStructuralInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) =>
        dispatch({ type: 'bulkStructural', ...input }, abortSignal),
    }),
    injectCss: tool({
      description:
        'Inject a page-level STYLESHEET. This is the right primitive for a broad redesign, and ' +
        'usually a better one than many setStyle calls: write real selectors, custom properties, ' +
        'a type scale, and MEDIA QUERIES — which a per-element style cannot express at all, so ' +
        'this is the only way to make a design actually responsive. Re-injecting with the same ' +
        '`id` REPLACES that sheet, so refine by re-sending a corrected sheet rather than layering ' +
        'overrides on your own earlier mistakes. Write rules a developer would recognise ' +
        '(`margin: 0 auto`, tokens, `rem`, `clamp()`), never computed pixel values read back off ' +
        'the page. Reversible and recorded in the changeset as a stylesheet.',
      inputSchema: InjectCssInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'injectCss', ...input }, abortSignal),
    }),
    pageOp: tool({
      description:
        'Run one bundled page operation the DOM cannot answer on its own — derived layout ' +
        '(`box`, `overflow`, `scrollContainer`, `stacking`, `visibility`), motion control ' +
        '(`animations`, `freezeMotion`, `media` — freeze motion before a screenshot to make it ' +
        'deterministic), and form state. Pick an `op` and pass its parameters; this never ' +
        'executes code you wrote. `overflow` with no selector audits the WHOLE document for ' +
        'horizontal overflow — the most common responsive defect, and one no per-element read ' +
        'can find.',
      inputSchema: PageOpInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'pageOp', ...input }, abortSignal),
    }),
    undo: tool({
      description: 'Revert the most recent recorded page mutation. Takes no arguments.',
      inputSchema: UndoInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'undo', ...input }, abortSignal),
    }),
    discardUndo: tool({
      description:
        'Discard the most recent undo entry WITHOUT reverting it. Use ONLY when its revert ' +
        'keeps failing (the page changed under the mutation, so its anchor is gone) and it is ' +
        'blocking older undo entries — the discard is permanent and is never what you want while ' +
        'a normal `undo` still works. Takes no arguments.',
      inputSchema: DiscardUndoInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'discardUndo', ...input }, abortSignal),
    }),
    diagnostics: tool({
      description:
        '`drain` returns (and clears) the runtime/network signals buffered since the last ' +
        'drain — console errors/warnings, uncaught exceptions, failed/slow requests. `scan` ' +
        'runs a fresh accessibility + layout pass. ToolResult.data = { signals: CollectorSignal[] }. ' +
        'Debug-mode first move: observe before you reproduce.',
      inputSchema: DiagnosticsInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'diagnostics', ...input }, abortSignal),
    }),
  };
}
