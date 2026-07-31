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
// Widened 2026-07-31 (#168): query / getStyles / a11ySnapshot were missing, so the very reads
// the system prompt tells the model to batch ("several small reads cost far less") serialized
// behind the per-tab capture mutex — contradicting the "reads stay outside for throughput"
// intent above. Audit per tool (src/dom/read.ts): `query` resolves selectors + derives stable
// selectors via pickUnique — no rects, no scrolling, no synthetic events; `getStyles` projects
// getComputedStyle values — scroll-independent; `a11ySnapshot` walks roles/names off
// attributes/text — scroll-independent. None dispatches events or mutates. NOT widened:
// `screenshot` (the capture itself), every mutation (`setStyle`/`setText`/structural), every
// driver (`click`/`type`/`scrollTo`/…), `diagnostics` (its `scan` reads layout geometry that a
// mid-sweep emulation resize would skew), and `chartTooltip` (synthetic hover — see above).
// A `readText` message type does not exist on the bus (checked `src/shared/messages.ts`).
export const UNLOCKED_READS: ReadonlySet<string> = new Set([
  'describe',
  'extractIdentity',
  'readImageContent',
  'readImages',
  'readChart',
  'pageFacts',
  'checkResponsive',
  'query',
  'getStyles',
  'a11ySnapshot',
]);

/** Whether one content-routed message type rides the per-tab capture lock (#136). Everything not
 *  a named pure read locks: all DomTool mutations, `screenshot`, `diagnostics`, and every
 *  page-driving ControlTool. */
export function shouldRideCaptureLock(type: string): boolean {
  return !UNLOCKED_READS.has(type);
}

// DEADLOCK INVARIANT (the reason this policy can widen the lock safely): nothing that already
// holds the per-tab lock may re-enter the locking dispatch. Concretely — captureFullPage's band
// scrolls + page-metrics are raw chrome.tabs calls; runResponsiveCapture's internal captures use
// `sendContentRaw` / captureFullPage-direct, never contentDispatchFor/screenshotDispatchFor; and
// setDevice/restoreDevice are CDP/window drivers that never send a content message. A locking
// dispatch nested under a held lock queues behind itself: a self-deadlock.
