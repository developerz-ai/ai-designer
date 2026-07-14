// Browser-control interaction tools for the agent loop (slice 13) — the "drive the page like a
// user" half. Derived 1:1 from the Zod input consts in `src/shared/messages.ts` (the same zero-drift
// contract `createDomTools` holds): the tool NAME is the schema's `type` discriminant and the
// `inputSchema` is that const minus `type`, so the model never supplies the discriminant and the two
// can't drift. Every input spreads the shared `Target`, so each tool addresses an optional
// `{ tabId?, frameId? }` — the agent operates inside iframes and across tabs.
//
// SW-ONLY by usage, chrome-free by construction. Two injected dispatches:
//   • `control` round-trips the page-driving actions (click / type / … / handleDialog) to the target
//     frame's content script (`chrome.tabs.sendMessage(tabId, msg, { frameId })`).
//   • `nav` runs navigation in the SW (it drives `chrome.tabs.update`/`goBack`/`reload` and awaits
//     the load — it cannot be content-routed because it tears the content script down).
// Both are injected so this module stays testable with no `chrome.*`; the loop wires the real ones.

import { tool } from 'ai';
import {
  ClickInput,
  type ControlTool,
  HandleDialogInput,
  HoverInput,
  type NavIntent,
  NavigateBackInput,
  NavigateInput,
  PressKeyInput,
  ReloadInput,
  ScrollToInput,
  SelectOptionInput,
  ToolResult,
  TypeInput,
  WaitForInput,
} from '@/shared/messages';

/** Round-trips one page-driving `ControlTool` to the target frame's content script. */
export type ControlDispatch = (msg: ControlTool, signal?: AbortSignal) => Promise<ToolResult>;

/** Runs one navigation intent in the SW (drives the tab, awaits the load). */
export type NavDispatch = (msg: NavIntent, signal?: AbortSignal) => Promise<ToolResult>;

export interface InteractDeps {
  readonly control: ControlDispatch;
  readonly nav: NavDispatch;
}

/**
 * Build the browser-control interaction `ToolSet` for one turn. Each `execute` reattaches the tool
 * name's `type` discriminant, forwards the model's args (incl. the `Target`), threads the abort
 * signal, and returns the dispatch's `ToolResult` verbatim. Composed alongside the DOM, tabs,
 * vision, session, and MCP tools in the loop.
 */
export function createInteractTools({ control, nav }: InteractDeps) {
  return {
    click: tool({
      description:
        'Click the element matching `selector` (scrolled into view first) with a realistic pointer ' +
        '+ mouse + click sequence, so framework listeners react as they would to a real user. Use ' +
        'it to drive the page: open a menu, submit, toggle, follow a control.',
      inputSchema: ClickInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => control({ type: 'click', ...input }, abortSignal),
    }),
    type: tool({
      description:
        'Type `text` into the text field / contenteditable matching `selector` (fires input + ' +
        'change so React/Vue tracking sees it). Set `submit: true` to press Enter and submit the ' +
        'form afterwards. For a native <select>, use `selectOption` instead.',
      inputSchema: TypeInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => control({ type: 'type', ...input }, abortSignal),
    }),
    pressKey: tool({
      description:
        'Press a single key on the focused element — e.g. "Enter", "Escape", "Tab", "ArrowDown". ' +
        'For entering text, prefer `type`.',
      inputSchema: PressKeyInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => control({ type: 'pressKey', ...input }, abortSignal),
    }),
    hover: tool({
      description:
        'Hover the element matching `selector` (pointer/mouse over) to reveal hover menus, ' +
        'tooltips, or lazy content, without clicking.',
      inputSchema: HoverInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => control({ type: 'hover', ...input }, abortSignal),
    }),
    scrollTo: tool({
      description:
        'Scroll an element into view (`selector`) or to an absolute page offset (`y`). With ' +
        'neither, it reports the current scroll position + page dimensions. Use it to reach ' +
        'off-screen content before reading or capturing it.',
      inputSchema: ScrollToInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => control({ type: 'scrollTo', ...input }, abortSignal),
    }),
    selectOption: tool({
      description:
        'Choose an option in the <select> or ARIA listbox/combobox matching `selector`, by `value` ' +
        '(falling back to the visible label). Fires input + change.',
      inputSchema: SelectOptionInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => control({ type: 'selectOption', ...input }, abortSignal),
    }),
    waitFor: tool({
      description:
        'Block until a condition holds, then return: a `selector`/`text` appears, or the DOM goes ' +
        'quiet (`networkIdle`), or just `timeMs` elapses. Bounded (hard-capped at 30s) so a stuck ' +
        'page cannot hang the turn. Use it after an action that loads content before reading it.',
      inputSchema: WaitForInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => control({ type: 'waitFor', ...input }, abortSignal),
    }),
    handleDialog: tool({
      description:
        'Arm the answer for a native dialog (alert / confirm / prompt) that YOUR next action will ' +
        'raise: `accept` = OK vs Cancel, `promptText` fills a prompt(). Only for dialogs the agent ' +
        'triggers — a dialog the user raised is never dismissed for them.',
      inputSchema: HandleDialogInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => control({ type: 'handleDialog', ...input }, abortSignal),
    }),
    navigate: tool({
      description:
        'Navigate the tab to `url` and wait for the load. ToolResult.data = { url, title } of where ' +
        'it landed. Not reversible and it discards the current ephemeral live-edit — confirm with ' +
        'the user before leaving a page with unsaved edits.',
      inputSchema: NavigateInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => nav({ type: 'navigate', ...input }, abortSignal),
    }),
    navigateBack: tool({
      description:
        'Go back one entry in the tab’s history and wait for the load. Discards the current ' +
        'ephemeral live-edit.',
      inputSchema: NavigateBackInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => nav({ type: 'navigateBack', ...input }, abortSignal),
    }),
    reload: tool({
      description:
        'Reload the tab and wait for the load — e.g. to reproduce a bug from a clean state. Discards ' +
        'the current ephemeral live-edit.',
      inputSchema: ReloadInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => nav({ type: 'reload', ...input }, abortSignal),
    }),
  };
}
