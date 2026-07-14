// Cross-site browse orchestration — the decision logic behind the `browse(url)` tool, lifted out
// of `src/entrypoints/background.ts` so it's chrome-free and unit-testable (the entrypoint is
// coverage-excluded). Every chrome-coupled step (host grant, tab create/wait/read/close) is a
// method on an injected `BrowseTabDriver`; this module only sequences them and guarantees the
// invariants: validate the URL, gate on a per-origin permission, and ALWAYS close the tab — even
// on a read failure or a mid-flight abort. Mirrors the "inject the side effect" doctrine the
// agent loop uses for the DOM bus (`DomDispatch`).

import { type HostAccess, originPattern } from '@/shared/host-permissions';
import type { BrowseInput, DesignRead, ToolResult } from '@/shared/messages';

/** The chrome-coupled primitives `runBrowse` sequences. Implemented in the service worker
 *  (`background.ts`) against `chrome.tabs` / `chrome.permissions`; faked in tests. */
export interface BrowseTabDriver {
  /** Ensure the calling context can reach `url` (per-origin optional_host_permissions grant). */
  hostAccess(url: string): Promise<HostAccess>;
  /** Open `url` in an INACTIVE background tab; resolve its tab id (or `undefined` if none). */
  open(url: string): Promise<number | undefined>;
  /** Resolve once the tab finishes loading (or a load timeout elapses); reject on abort/close. */
  waitForLoad(tabId: number, signal?: AbortSignal): Promise<void>;
  /** Ask the tab's content script for its compact design read. */
  readDesign(tabId: number, signal?: AbortSignal): Promise<DesignRead>;
  /** Close the background tab. */
  close(tabId: number): Promise<void>;
}

/**
 * Run one `browse(url)` call: permission-gate → open an inactive tab → wait for load → read its
 * design identity → close the tab. Returns a `ToolResult` whose `data` is a {@link DesignRead}
 * on success; a denied grant, an invalid URL, an unreachable tab, or an abort all degrade to an
 * error result the model can react to (never a thrown turn). The tab is always closed.
 */
export async function runBrowse(
  driver: BrowseTabDriver,
  input: BrowseInput,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (signal?.aborted) return browseError('aborted');
  if (!originPattern(input.url)) return browseError(`Invalid URL to browse: ${input.url}`);

  const access = await driver.hostAccess(input.url);
  if (!access.ok) {
    return browseError(
      access.error ??
        `I don't have permission to open ${input.url}. Grant page access, then retry.`,
    );
  }

  let tabId: number | undefined;
  try {
    tabId = await driver.open(input.url);
    if (tabId === undefined) return browseError('Could not open a background tab to browse.');
    await driver.waitForLoad(tabId, signal);
    const read = await driver.readDesign(tabId, signal);
    return { type: 'tool-result', ok: true, data: read };
  } catch (err) {
    return browseError(signal?.aborted ? 'aborted' : String(err));
  } finally {
    // Best-effort close: a browse tab must never outlive its call, even if close() itself throws.
    if (tabId !== undefined) await driver.close(tabId).catch(() => {});
  }
}

/** A failed `browse` `ToolResult` — surfaced to the model so it can relay the reason (e.g. ask
 *  the user to grant access) rather than the turn dying. */
export function browseError(error: string): ToolResult {
  return { type: 'tool-result', ok: false, error };
}
