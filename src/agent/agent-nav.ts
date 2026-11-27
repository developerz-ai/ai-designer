// "Did the AGENT cause this navigation?" — the per-tab marker the onCommitted listener reads to
// tell turn work (rebase, keep going) from the page/user navigating out from under the turn
// (abort). See nav-abort.ts for the decision table this feeds.
//
// TWO SOURCES OF AGENT NAVIGATION, one marker:
//   • the nav drivers (`navigate`/`back`/`reload`), which run while their commit lands — `runNav`
//     waits for load-complete, so the commit is always inside the window;
//   • content INTERACTIONS that can navigate: a link `click`, `type` with `submit`, a `pressKey`
//     (Enter on a form field, a keyboard shortcut), `selectOption` (a jump menu's onchange), a
//     `widgetAct`, and `pageOp(pageCall)` (`app.router.push`). Their content round-trip returns
//     as soon as the event is dispatched, while the commit lands whenever the server answers —
//     so the window stays open for a GRACE period after the call returns.
//
// The grace is a trade-off, stated: a USER navigation inside it is treated as the agent's (the
// turn rebases onto the new document instead of aborting). That is the benign direction — the
// turn keeps working on the page the tab now shows, and old-document edits are dropped either
// way — while a window too short aborts the turn the agent itself navigated, which is the bug.
//
// Pure + chrome-free + clock-injectable, so the window is unit-testable.

import type { ContentRoutedMessage } from './tab-guard';

/** How long after an agent interaction returns a main-frame commit still counts as its doing. */
export const AGENT_NAV_GRACE_MS = 5_000;

/** Whether one content-routed message can trigger a cross-document navigation of its tab. */
export function mayNavigate(message: ContentRoutedMessage): boolean {
  switch (message.type) {
    case 'click':
    case 'pressKey':
    case 'selectOption':
    case 'widgetAct':
      return true;
    case 'type':
      return message.submit === true;
    case 'pageOp':
      return message.op.op === 'pageCall';
    default:
      return false;
  }
}

/** Per-tab "agent navigation in flight" marker: open while a marked call runs, and for
 *  `graceMs` after the last one ends. Counted, so overlapping calls on one tab nest. */
export class AgentNavMarker {
  private readonly active = new Map<number, number>();
  private readonly graceUntil = new Map<number, number>();

  constructor(
    private readonly graceMs: number = AGENT_NAV_GRACE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Open the window for `tabId`; the returned release closes this call's share of it (and
   *  starts the grace). Idempotent: a second release is a no-op. */
  begin(tabId: number): () => void {
    this.active.set(tabId, (this.active.get(tabId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(tabId) ?? 1) - 1;
      if (left > 0) this.active.set(tabId, left);
      else this.active.delete(tabId);
      this.graceUntil.set(tabId, this.now() + this.graceMs);
    };
  }

  /** Whether a commit on `tabId` right now is the agent's doing. */
  has(tabId: number): boolean {
    if ((this.active.get(tabId) ?? 0) > 0) return true;
    const until = this.graceUntil.get(tabId);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.graceUntil.delete(tabId);
    return false;
  }

  /** Forget a tab entirely (closed — a recycled id must not inherit the window). */
  forget(tabId: number): void {
    this.active.delete(tabId);
    this.graceUntil.delete(tabId);
  }

  /** Run `fn` inside the window for `tabId`. */
  async within<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const release = this.begin(tabId);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
