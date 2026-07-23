// The page-driver-vs-capture serialization POLICY (#136), shared so the service worker
// (src/entrypoints/background.ts `contentDispatchFor`) and the integration pin
// (test/integration/capture-serialization.test.ts) read the SAME set — a hand-copied set in two
// places desyncs silently, and a wrong entry here either re-opens mid-stitch corruption (a driver
// left unlocked) or stalls harmless reads behind every stitch (a read locked).
//
// THE SET HOLDS THE PURE READS (unlocked): message types that never scroll or mutate the page and
// whose results are scroll-independent. Audit trail (2026-07-23): readImages (natural sizes),
// readChart (bridge probe, read-only), pageFacts (structure read), the describe family
// (text/identity extraction, no dispatch), checkResponsive (geometry read — scrollWidth/
// clientWidth, scroll-independent). chartTooltip was introduced unlocked in #145's first cut and
// REMOVED on review: it dispatches synthetic mouseover/mouseout on the chart host
// (src/dom/charts.ts:350-358) — hover-by-another-name, and page/chart handlers can react with
// layout-shifting side effects mid-stitch. Only widgets.ts's widgetAct and interact.ts's drivers
// scroll — all locked.
export const UNLOCKED_READS: ReadonlySet<string> = new Set([
  'describe',
  'extractIdentity',
  'readImageContent',
  'readImages',
  'readChart',
  'pageFacts',
  'checkResponsive',
]);

/** Whether one content-routed message type rides the per-tab capture lock (#136). Everything not
 *  a named pure read locks: all DomTool mutations/reads and every page-driving ControlTool. */
export function shouldRideCaptureLock(type: string): boolean {
  return !UNLOCKED_READS.has(type);
}

// DEADLOCK INVARIANT (the reason this policy can widen the lock safely): nothing that already
// holds the per-tab lock may re-enter the locking dispatch. Concretely — captureFullPage's band
// scrolls + page-metrics are raw chrome.tabs calls; runResponsiveCapture's internal captures use
// `sendContentRaw` / captureFullPage-direct, never contentDispatchFor/screenshotDispatchFor; and
// setDevice/restoreDevice are CDP/window drivers that never send a content message. A locking
// dispatch nested under a held lock queues behind itself: a self-deadlock.
