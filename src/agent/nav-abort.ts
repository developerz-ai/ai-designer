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
//   • The agent's OWN navigation — the nav drivers (`navigate`/`back`/`reload`) AND content
//     interactions that commit a new document (a link `click`, `type{submit}`, `pressKey`…), all
//     marked by `agent-nav.ts`'s window. That is deliberate turn work: the turn REBASES instead
//     (`shouldRebaseTurnOnCommit` → `TurnChangeset.rebase`): nav-clear wipes the old document's
//     edits from the mirrors, and the turn's store moves to the new document so its later edits
//     persist.
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
  /** Whether the agent's navigation window is open on this tab (`agentNav.has(tabId)`). */
  readonly agentNavInFlight: boolean;
}

/** Should this main-frame commit abort the in-flight turn? See the header for the table. */
export function shouldAbortTurnOnCommit(ctx: CommitAbortContext): boolean {
  if (ctx.frameId !== 0) return false;
  if (!ctx.turnRunning || ctx.runningTurnTabId !== ctx.tabId) return false;
  return !ctx.agentNavInFlight;
}

/** Should this main-frame commit move the running turn's changeset onto the new document? Exactly
 *  the agent-navigation commits the abort above lets through: same tab, turn live, agent window
 *  open. (`TurnChangeset.rebase` itself is a no-op for a same-URL reload.) */
export function shouldRebaseTurnOnCommit(ctx: CommitAbortContext): boolean {
  if (ctx.frameId !== 0) return false;
  if (!ctx.turnRunning || ctx.runningTurnTabId !== ctx.tabId) return false;
  return ctx.agentNavInFlight;
}
