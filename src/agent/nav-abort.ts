// Mid-turn navigation abort — the decision half (#148 item 2). A cross-document commit of the
// RUNNING turn's tab means the document the turn was editing is gone: its live edits died, its
// selectors point into a dead DOM, and every later tool call would act on a page the user never
// asked it to touch. Abort is the safe answer (the issue weighed abort vs rebase; rebase preserves
// work the new document cannot carry anyway).
//
// What must NOT abort:
//   • Same-document navigations (hash change, history.pushState) — no cross-document commit
//     fires for those, so they never reach this decision; the caller's `frameId === 0` +
//     onCommitted source guarantees it.
//   • Iframe commits — a child frame navigating is routine page behavior (`frameId !== 0`).
//   • The agent's OWN `navigate`/`back`/`reload` (the nav drivers run under a per-tab
//     "agent nav in flight" marker) — that is deliberate turn work; the mirrors are still wiped
//     by nav-clear, and the turn's persist guard stops the in-flight store from re-persisting
//     old-URL edits (the residual the issue names).
//   • Commits on any tab but the running turn's, and commits with no turn running.
//
// A user-triggered RELOAD does abort: it is a cross-document commit, the live edits died with it,
// and the turn would continue against a page that no longer shows its work.
//
// Pure by construction — background.ts owns the chrome listener and the state reads; the
// integration suite pins this table without importing the entrypoint.

export interface CommitAbortContext {
  /** The committed frame — only the main frame (0) can end a turn. */
  readonly frameId: number;
  /** The tab the commit happened on. */
  readonly tabId: number;
  /** The tab the RUNNING turn is working against (`runningTurnTabId`), null between turns. */
  readonly runningTurnTabId: number | null;
  /** Whether a turn is live (`turnAbort !== null`). */
  readonly turnRunning: boolean;
  /** Whether the agent's own nav driver holds this tab (`agentNavTabs.has(tabId)`). */
  readonly agentNavInFlight: boolean;
}

/** Should this main-frame commit abort the in-flight turn? See the header for the table. */
export function shouldAbortTurnOnCommit(ctx: CommitAbortContext): boolean {
  if (ctx.frameId !== 0) return false;
  if (!ctx.turnRunning || ctx.runningTurnTabId !== ctx.tabId) return false;
  return !ctx.agentNavInFlight;
}
