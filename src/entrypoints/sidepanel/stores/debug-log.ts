import { DebugLogResult } from '@/shared/messages';
import { request } from './bus';

// The Copy-debug-log action (CLAUDE.md "SolidJS + SRP": the work lives outside the component).
//
// The MARKDOWN IS RENDERED IN THE SERVICE WORKER (`src/agent/turn-log.ts`), not here. The panel has
// no way to know the extension version, the configured model or the provider origin, and rendering
// it panel-side would mean shipping raw log entries plus a second copy of the format. So this module
// does exactly the two things the panel is the right world for: ask, and put it on the clipboard.
//
// STATELESS ON PURPOSE. The button's transient label ("Copying…", "Copied") is view state belonging
// to one control, so it lives in the component. A module-level signal here would be a singleton
// shared by every render of the panel — which is exactly how the first version of this leaked a
// stale "Copied" into an unrelated mount.

/** What a press ended up doing. Both outcomes are reportable — see `copyDebugLog`. */
export type CopyOutcome = 'copied' | 'failed';

/**
 * Fetch this conversation's debug log and write it to the clipboard.
 *
 * Never throws — the button's whole job is to be safe to press. A clipboard write can be refused
 * (the document must be focused, and the permission can be denied) and the service worker can
 * answer with a malformed reply; both come back as `'failed'` so the UI can SAY so, instead of the
 * panel logging an unhandled rejection the user never sees while believing they copied a log.
 */
export async function copyDebugLog(): Promise<CopyOutcome> {
  try {
    const { markdown } = await request({ type: 'debug-log-get' }, DebugLogResult);
    await navigator.clipboard.writeText(markdown);
    return 'copied';
  } catch {
    return 'failed';
  }
}
