// Which tab's CONVERSATION an out-of-band read answers for. Its own module (not thread-view.ts —
// tab resolution isn't thread rendering, and not background.ts — that file can't be imported
// under Vitest): background's `thread-get` and `debug-log-get` both resolve through this, each
// with its own priority order.

/** The tab whose conversation an out-of-band read should answer for. First candidate that HAS a
 *  session wins; `null` when none does (the caller falls back to the active tab and reports
 *  "no session yet"). A running turn's tab leads: the turn owns the panel's transcript, and
 *  resolving the ACTIVE tab mid-turn is what let `tabs(op:'open')` blank the user's chat. */
export function conversationTabId(
  preferred: readonly (number | null | undefined)[],
  hasSession: (tabId: number) => boolean,
): number | null {
  for (const c of preferred) if (typeof c === 'number' && hasSession(c)) return c;
  return null;
}
