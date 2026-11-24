import { DebugLogResult } from '@/shared/messages';
import { request } from './bus';
import { viewTabId } from './chat';

// The debug-log actions — Copy AND View share one module (CLAUDE.md "SolidJS + SRP": the work
// lives outside the components).
//
// The MARKDOWN IS RENDERED IN THE SERVICE WORKER (`src/agent/turn-log.ts`), not here. The panel has
// no way to know the extension version, the configured model or the provider origin, and rendering
// it panel-side would mean shipping raw log entries plus a second copy of the format. So this module
// does exactly the things the panel is the right world for: ask (`fetchDebugLog` — one RPC shape
// for both the clipboard and the viewer), put it on the clipboard (`copyDebugLog`), and hand the
// viewer the same fetched shape to display.
//
// STATELESS ON PURPOSE. The buttons' transient state ("Copying…", the open viewer) is view state
// belonging to one control, so it lives in the components. A module-level signal here would be a
// singleton shared by every render of the panel — which is exactly how the first version of this
// leaked a stale "Copied" into an unrelated mount.

/** What a press ended up doing. All outcomes are reportable — see `copyDebugLog`. */
export type CopyOutcome = 'copied' | 'empty' | 'failed';

/** One fetched log, ready to display or copy. `entries` is the SW's own count when it sent one;
 *  `empty` is the settled answer either way (count preferred, header regex as the fallback). */
export interface FetchedLog {
  readonly markdown: string;
  readonly entries?: number;
  readonly empty: boolean;
}

/** `fetchDebugLog`'s result — a discriminated shape rather than a throw, so both consumers (a
 *  clipboard press, a viewer refresh) stay safe to fire without their own try/catch. */
export type FetchLogResult = ({ ok: true } & FetchedLog) | { ok: false };

/** Whether a rendered log carries no ENTRIES. `renderTurnLog` always emits a header, so a
 *  header-only document copies "successfully" and pastes nothing.
 *  FALLBACK ONLY: `DebugLogResult.entries` is the real answer and `fetchDebugLog` prefers it; this
 *  regex covers a pre-`entries` SW by reading the count the header states (`- entries: N`) — a
 *  line src/agent/turn-log.ts owns, which is exactly why the schema field supersedes it. */
const ENTRY_COUNT = /^-[ \t]*entries:[ \t]*(\d+)/m;

export function logHasNoEntries(markdown: string): boolean {
  const m = ENTRY_COUNT.exec(markdown);
  return m ? m[1] === '0' : markdown.trim().length === 0;
}

/**
 * Fetch this conversation's debug log, rendered SW-side. THE one RPC call both the clipboard and
 * the viewer ride — keeping the call shape here means "what you see" and "what you copy" can never
 * be two different asks.
 *
 * Pinned to the conversation this panel is showing (`stores/chat.ts` `viewTabId`, additive
 * `tabId`) — without it the SW resolves the conversation itself, which mid-turn may not be the one
 * whose trace the user is reporting. Undefined while unkeyed: the SW then resolves.
 *
 * Never throws — a malformed SW reply or a transport blip comes back as `{ ok: false }` so the
 * pressed control can SAY so instead of the panel logging an unhandled rejection.
 */
export async function fetchDebugLog(): Promise<FetchLogResult> {
  try {
    const { markdown, entries } = await request(
      { type: 'debug-log-get', tabId: viewTabId() ?? undefined },
      DebugLogResult,
    );
    // The schema's own count is the answer; the header regex only covers a pre-`entries` SW.
    const empty = entries !== undefined ? entries === 0 : logHasNoEntries(markdown);
    return { ok: true, markdown, entries, empty };
  } catch {
    return { ok: false };
  }
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
  const fetched = await fetchDebugLog();
  if (!fetched.ok) return 'failed';
  try {
    await navigator.clipboard.writeText(fetched.markdown);
  } catch {
    return 'failed';
  }
  return fetched.empty ? 'empty' : 'copied';
}
