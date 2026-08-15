import { DebugLogResult } from '@/shared/messages';
import { request } from './bus';
import { viewTabId } from './chat';

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

/** What a press ended up doing. All outcomes are reportable — see `copyDebugLog`. */
export type CopyOutcome = 'copied' | 'empty' | 'failed';

/** Whether a rendered log carries no ENTRIES. `renderTurnLog` always emits a header, so a
 *  header-only document copies "successfully" and pastes nothing.
 *  FALLBACK ONLY: `DebugLogResult.entries` is the real answer and `copyDebugLog` prefers it; this
 *  regex covers a pre-`entries` SW by reading the count the header states (`- entries: N`) — a
 *  line src/agent/turn-log.ts owns, which is exactly why the schema field supersedes it. */
const ENTRY_COUNT = /^-[ \t]*entries:[ \t]*(\d+)/m;

export function logHasNoEntries(markdown: string): boolean {
  const m = ENTRY_COUNT.exec(markdown);
  return m ? m[1] === '0' : markdown.trim().length === 0;
}

/**
 * Fetch this conversation's debug log and write it to the clipboard.
 *
 * Never throws — the button's whole job is to be safe to press. A clipboard write can be refused
 * (the document must be focused, and the permission can be denied) and the service worker can
 * answer with a malformed reply; both come back as `'failed'` so the UI can SAY so, instead of the
 * panel logging an unhandled rejection the user never sees while believing they copied a log.
 *
 * A log with zero entries still gets written — the header names the tab, model and provider,
 * which is worth pasting — but the outcome says `'empty'` so the button can tell the user the
 * trace they think they copied has nothing in it yet.
 */
export async function copyDebugLog(): Promise<CopyOutcome> {
  try {
    // Pinned to the conversation this panel is showing (`stores/chat.ts` `viewTabId`, additive
    // `tabId`) — without it the SW resolves the conversation itself, which mid-turn may not be
    // the one whose trace the user is reporting. Undefined while unkeyed: the SW then resolves.
    const { markdown, entries } = await request(
      { type: 'debug-log-get', tabId: viewTabId() ?? undefined },
      DebugLogResult,
    );
    await navigator.clipboard.writeText(markdown);
    // The schema's own count is the answer; the header regex only covers a pre-`entries` SW.
    const empty = entries !== undefined ? entries === 0 : logHasNoEntries(markdown);
    return empty ? 'empty' : 'copied';
  } catch {
    return 'failed';
  }
}
