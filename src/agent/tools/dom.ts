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
  DiagnosticsInput,
  type DomTool,
  GetStylesInput,
  QueryInput,
  ScreenshotInput,
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
        'Replace the visible text content of the element matching `selector`. ' +
        'Reversible and recorded as an edit.',
      inputSchema: SetTextInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'setText', ...input }, abortSignal),
    }),
    undo: tool({
      description: 'Revert the most recent recorded page mutation. Takes no arguments.',
      inputSchema: UndoInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'undo', ...input }, abortSignal),
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
