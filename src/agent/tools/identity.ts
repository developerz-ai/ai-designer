// The `extractIdentity` tool for the agent loop (slice 14) — reduce the live page to a compact,
// token-like design identity (role-tagged palette + type scale + spacing/radius/shadow rhythm) so
// `copy` reuses a reference's brand and reports render tokens, not raw hex. Derived 1:1 from the
// `ExtractIdentityInput` Zod const (the tool NAME carries the `type` discriminant; `inputSchema` is
// that const minus `type`), the same zero-drift contract the other tool modules hold.
//
// SW-ONLY by usage, chrome-free by construction: `execute` is a bus round-trip to an injected
// `IdentityDispatch`, which `chrome.tabs.sendMessage`s the `extractIdentity` command to the content
// script (the only world with the DOM + computed styles) and resolves the typed `ToolResult`
// (`data` = an `IdentityResult`). Injected, so this stays unit-testable, exactly like `createDomTools`.

import { tool } from 'ai';
import { ExtractIdentityInput, ToolResult } from '@/shared/messages';

/** Round-trips one `extractIdentity` call to the content script's identity extractor and resolves its
 *  `ToolResult` (`data` = an `IdentityResult`). Injected here so the tool stays chrome-free and
 *  testable; the real transport is wired in the agent loop. */
export type IdentityDispatch = (
  input: ExtractIdentityInput,
  signal?: AbortSignal,
) => Promise<ToolResult>;

/**
 * Build the `extractIdentity` tool for one turn. Returned as its own single-entry object (not merged
 * here) so the loop composes it alongside the DOM, describe, browse, and vision tools — mirroring
 * `createBrowseTool`. `execute` reattaches the `extractIdentity` discriminant the tool name carries
 * (plus the model's `Target`) and proxies to `dispatch`, returning the content `ToolResult` verbatim.
 */
export function createIdentityTool(dispatch: IdentityDispatch) {
  return {
    extractIdentity: tool({
      description:
        "Extract the page's design identity as compact tokens: a role-tagged color palette " +
        '(bg / fg / accent / border, frequency-ranked), the type scale (font families, sizes, ' +
        'weights), and the spacing / border-radius / box-shadow rhythm. ToolResult.data = an ' +
        'IdentityResult. A cheap DOM read (no screenshot). Use it to copy a reference site’s brand ' +
        'onto the user’s page, or to describe the current design in tokens for a report.',
      inputSchema: ExtractIdentityInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) =>
        dispatch({ type: 'extractIdentity', ...input }, abortSignal),
    }),
  };
}
