// The cross-site `browse` tool for the agent loop. Like the DOM tools it's derived 1:1 from a
// Zod input const in `src/shared/messages.ts` (`BrowseInput`) so the tool name and schema can't
// drift: the tool NAME is the schema's `type` discriminant and the `inputSchema` is that const
// minus `type` (the tool name carries the discriminant, so the model never supplies it).
//
// SW-ONLY, but chrome-free by construction: `execute` is a bus round-trip to an injected
// `BrowseDispatch`, which (in `src/entrypoints/background.ts`) opens the reference site in an
// INACTIVE background tab, snapshots its design identity, and closes it — never hijacking the
// user's tab. Dispatch is injected (not performed here) so this module stays chrome-free +
// unit-testable, exactly like `createDomTools`. A denied per-origin host grant, an unreachable
// site, or an abort all come back as an error `ToolResult` the model can react to.

import { tool } from 'ai';
import { BrowseInput, ToolResult } from '@/shared/messages';

/** Round-trips one `browse` call to the service worker's background-tab snapshot and resolves
 *  its `ToolResult` (`data` = a `DesignRead`). Injected here so the tool stays chrome-free and
 *  testable; the real lifecycle (tab create → inject → design-read → close) lives in the SW. */
export type BrowseDispatch = (input: BrowseInput, signal?: AbortSignal) => Promise<ToolResult>;

/**
 * Build the `browse` tool for one turn. Returned as its own single-entry object (not merged
 * here) so the agent loop can compose it alongside the DOM, session, and MCP tools — mirroring
 * `createDomTools`. `execute` reattaches the `browse` discriminant the tool name carries and
 * proxies to `dispatch`, returning the SW's `ToolResult` verbatim.
 */
export function createBrowseTool(dispatch: BrowseDispatch) {
  return {
    browse: tool({
      description:
        'Open a reference site in a BACKGROUND tab (never the tab the user is on), read its ' +
        'visual identity, and close it. ToolResult.data = a compact, token-bounded design read: ' +
        'color palette (with roles), typography (families + type scale), layout regions, and ' +
        'key components — a site’s identity in text, cheaper than a screenshot and reusable. ' +
        'Use it to copy or adapt a design from another site. Needs one-time page-access ' +
        'permission for the target origin; if that is denied the result says so — ask the ' +
        'user to grant access, then retry.',
      inputSchema: BrowseInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: ({ url }, { abortSignal }) => dispatch({ type: 'browse', url }, abortSignal),
    }),
  };
}
