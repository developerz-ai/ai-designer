// The capture-target guard (#165 S1). `chrome.tabs.captureVisibleTab(windowId)` takes NO tabId — it
// grabs whatever tab is ACTIVE in that window. Every capture path in the service worker resolves a
// `Target.tabId`, then captures by `windowId` alone, so a capture aimed at a background tab silently
// returned the user's own page instead:
//
//   copy mode opens reference site R in a background tab (the system prompt tells the model to);
//   the user's tab U stays active; `screenshot({ tabId: R, fullPage: true })` scroll-stitches R
//   band by band while every grab returns pixels of U. The model "copies" the user's page onto
//   itself, reports high fidelity, and the wrong PNGs are embedded in the shipped brief. The
//   element/viewport path is wrong the same way, and additionally applies R's crop geometry to U's
//   image.
//
// THE CHOICE: REFUSE, don't auto-activate. Activating the target under the per-tab capture lock was
// the alternative, and it is not safe here — `captureVisibleTab` is WINDOW-scoped, so activating R
// changes what a concurrent stitch on U (same window, its own per-tab lock) is grabbing. The lock
// cannot express a window-level mutation, so auto-activation trades one silent wrong-pixels bug for
// another. Refusing is deterministic, steals no focus mid-turn, and is recoverable in one step: the
// model already owns `tabs({ action: 'activate', tabId })`, and the error names it.
//
// Chrome-free by construction (the tab lookup is injected) so the guard is unit-testable; the SW
// binds it to `chrome.tabs.get`. Deadlock-invariant safe: a raw tab read, never a content dispatch.

/** The one field the guard reads off a tab. Structurally satisfied by `chrome.tabs.Tab`. */
export interface CaptureTargetTab {
  readonly active?: boolean;
}

/** Resolve a tab for the guard. Rejects/undefined for a tab that is gone. */
export type CaptureTargetProbe = (tabId: number) => Promise<CaptureTargetTab | undefined>;

/** The refusal the agent reads. Names the fix so a copy-mode turn recovers instead of retrying. */
export function inactiveCaptureError(tabId: number): string {
  return (
    `Tab ${tabId} is not the active tab in its window, and a screenshot can only capture the ` +
    `active tab — a capture here would silently return the OTHER tab's pixels. Call ` +
    `tabs({ action: 'activate', tabId: ${tabId} }) first, then capture, and activate the user's ` +
    'tab again when you are done.'
  );
}

/**
 * Why a capture of `tabId` must not proceed, or `null` when it may. A tab that can't be read at all
 * (closed mid-turn) is refused with the lookup's own reason — capturing "whatever is active" in its
 * place is the very bug this guards.
 */
export async function captureBlockedReason(
  probe: CaptureTargetProbe,
  tabId: number,
): Promise<string | null> {
  let tab: CaptureTargetTab | undefined;
  try {
    tab = await probe(tabId);
  } catch (err) {
    return `Could not resolve tab ${tabId} to capture: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!tab) return `Could not resolve tab ${tabId} to capture: no such tab.`;
  return tab.active ? null : inactiveCaptureError(tabId);
}
