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
import {
  A11ySnapshotInput,
  AddClassInput,
  DiagnosticsInput,
  DiscardUndoInput,
  type DomTool,
  GetStylesInput,
  InsertNodeInput,
  MoveNodeInput,
  QueryInput,
  RemoveClassInput,
  RemoveNodeInput,
  ScreenshotInput,
  SetAttrInput,
  SetStyleInput,
  SetTextInput,
  ToolResult,
  UndoInput,
} from '@/shared/messages';

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
        'Read the relevant computed styles of the element matching `selector`. ' +
        'ToolResult.data = { styles: Record<prop, value> }. Cheaper than a screenshot for ' +
        'checking current color, spacing, or typography.',
      inputSchema: GetStylesInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'getStyles', ...input }, abortSignal),
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
        'structure, labels, and hierarchy.',
      inputSchema: A11ySnapshotInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) =>
        dispatch({ type: 'a11ySnapshot', ...input }, abortSignal),
    }),
    setStyle: tool({
      description:
        'Apply CSS properties (prop -> value) to the element(s) matching `selector`. ' +
        'Reversible and recorded as an edit. ToolResult.data = the resulting computed subset.',
      inputSchema: SetStyleInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'setStyle', ...input }, abortSignal),
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
