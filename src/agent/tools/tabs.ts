// Multi-tab + frame tools for the agent loop (slice 13). Like the other tool modules they derive
// 1:1 from Zod input consts in `src/shared/messages.ts` (`TabsCmd` / `FramesInput`) — the tool name
// is the schema's `type` discriminant, the `inputSchema` is that const minus `type`, so the two
// can't drift.
//
// SW-ONLY: both stand on `chrome.tabs` / `chrome.webNavigation`, which the content world can't
// reach — so, unlike the content-routed DOM/interaction tools, they run entirely in the service
// worker. Chrome-free here by construction: each `execute` proxies to an injected dispatch
// (`runTabs` / `runFrames` in `src/agent/browser-control.ts`, behind a chrome driver wired in the
// loop), so this module stays unit-testable with no `chrome.*`.

import { tool } from 'ai';
import type { FramesInput, TabsCmd } from '@/shared/messages';
import {
  FramesInput as FramesInputSchema,
  TabsCmd as TabsCmdSchema,
  ToolResult,
} from '@/shared/messages';

/** Runs one `tabs` command against the SW's tab registry, returning the registry after it ran. */
export type TabsDispatch = (msg: TabsCmd, signal?: AbortSignal) => Promise<ToolResult>;

/** Enumerates a tab's frame tree (`chrome.webNavigation.getAllFrames`). */
export type FramesDispatch = (msg: FramesInput, signal?: AbortSignal) => Promise<ToolResult>;

export interface TabsToolDeps {
  readonly tabs: TabsDispatch;
  readonly frames: FramesDispatch;
}

/**
 * Build the tabs + frames `ToolSet` for one turn. `tabs` manages the tab lifecycle (copy runs the
 * user's tab and a reference tab at once, each addressed by `tabId`); `frames` lets the agent
 * discover an iframe's `frameId` so every DOM/control/vision tool can target it.
 */
export function createTabsTools({ tabs, frames }: TabsToolDeps) {
  return {
    tabs: tool({
      description:
        'Manage browser tabs. `action`: "list" (all tabs), "open" (needs `url`), "close" / ' +
        '"activate" (need `tabId`). ToolResult.data = { tabs: [{ tabId, url, title, active }] } — ' +
        'the full registry after the command. Address a specific tab in other tools via their ' +
        '`tabId`; open a reference site in its own tab to copy from it while keeping the user’s tab.',
      inputSchema: TabsCmdSchema.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => tabs({ type: 'tabs', ...input }, abortSignal),
    }),
    frames: tool({
      description:
        'List the frames (iframes) of a tab. ToolResult.data = { frames: [{ frameId, url, origin, ' +
        'isMain }] }. Use `frameId` in any DOM/control/vision tool’s `frameId` to operate inside a ' +
        'child frame — a cross-origin iframe is reached only through its own frame, never from the ' +
        'parent.',
      inputSchema: FramesInputSchema.omit({ type: true, action: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) =>
        frames({ type: 'frames', action: 'list', ...input }, abortSignal),
    }),
  };
}
