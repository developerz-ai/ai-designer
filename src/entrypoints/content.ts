import { defineContentScript } from '#imports';
import { createBridge } from '@/dom/bridge';
import { createChartReader } from '@/dom/charts';
import { describePage } from '@/dom/describe';
import { extractDesignRead } from '@/dom/design-read';
import { createDiagnosticsCollector, scanA11y, scanLayout } from '@/dom/diagnostics-collector';
import { createDomExecutor } from '@/dom/execute';
import { extractIdentity } from '@/dom/identity';
import { imageContent, readImages } from '@/dom/images';
import { createInteractor } from '@/dom/interact';
import { createMutator } from '@/dom/mutate';
import { createOverlay } from '@/dom/overlay';
import { createPageFacts } from '@/dom/page-facts';
import { createPicker } from '@/dom/picker';
import { createRouteObserver, waitForQuiescence } from '@/dom/quiescence';
import {
  needsScrollIntoView,
  pageMetrics,
  queryOne,
  screenshotRect,
  scrollableAncestors,
} from '@/dom/read';
import { createRecorder } from '@/dom/recorder';
import { scanResponsive } from '@/dom/responsive';
import { createWidgetDriver } from '@/dom/widgets';
import {
  type CaptureRequest,
  CaptureResult,
  CheckResponsiveInput,
  type CheckResponsiveResult,
  type ContentToSw,
  ControlTool,
  DescribeCmd,
  type DescribeResult,
  DesignReadRequest,
  type DesignReadResult,
  type DiagnosticsInput,
  DomTool,
  type IdentityResult,
  type ImageDescription,
  OverlayCmd,
  PageMetricsRequest,
  type PageMetricsResult,
  PickerCmd,
  type ReadImagesResult,
  type ToolResult,
} from '@/shared/messages';
import { readOverlayEnabled } from '@/shared/overlay-prefs';

// Content script — the only world with DOM access. It stays a THIN wire: Zod-gate inbound
// messages, hand them to the testable src/dom modules (executor + picker + recorder), and forward
// their ContentToSw events to the service worker. All logic lives in src/dom (jsdom-testable,
// coverage-counted); this entrypoint is coverage-excluded, so keep it minimal. Page mutations are
// EPHEMERAL + reversible (docs/idea/live-edit.md); the only durable output is the changeset (07).

// Paint-settle after scrolling an element into view before the SW captures — captureVisibleTab
// reads the composited surface, so an un-settled scroll would grab pre-scroll pixels (same value +
// rationale as the full-page stitch path's SCROLL_SETTLE_MS, background.ts). On a `scroll-behavior:
// smooth` page the scroll animates, so the settle is best-effort there — matching the repo's own
// scroll convention (none of interact.ts / widgets.ts / the full-page path forces an instant
// scroll).
const SCROLL_SETTLE_MS = 200;

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: true,
  matchAboutBlank: true,
  main() {
    // Push picker/recorder events to the SW (fire-and-forget). relay.ts maps them to the panel;
    // the SW folds recorder events into the changeset (slice 07). A dropped push (SW evicted
    // mid-session) is recoverable, so swallow the rejection rather than spam the page console.
    const emit = (msg: ContentToSw): void => {
      void chrome.runtime.sendMessage(msg).catch(() => {});
    };

    const mutator = createMutator();
    const recorder = createRecorder(emit);
    const executor = createDomExecutor({ mutator, recorder });
    const interactor = createInteractor();
    const picker = createPicker(emit);

    // Agent-decision overlay (slice 09), opt-in: restore the persisted toggle at injection time —
    // a page reload gets its overlay back without waiting on a round-trip to the SW — then react
    // to any live `overlay-toggle`/`overlay-step` the SW forwards for the rest of this page's life
    // (background.ts's `set-overlay-enabled` case / `forwardOverlayStep`).
    const overlay = createOverlay();
    void readOverlayEnabled().then((enabled) => overlay.toggle(enabled));

    // Complex-site reads/actions (slice 15, expose-to-agent): the MAIN-world bridge client
    // (read-only, non-secret — see the top-frame lifecycle block below) backs both the page-facts
    // cache and the chart data probe; the widget driver is pure DOM. Instantiated per-frame (not
    // gated to the top document) so an agent addressing a specific iframe's `frameId` still gets a
    // real chart/widget/page-facts read there.
    const bridge = createBridge();
    const pageFacts = createPageFacts({ bridge });
    const chartReader = createChartReader({ bridge });
    const widgetDriver = createWidgetDriver();

    // Chrome pins the top document to frameId 0; a child frame can't learn its own id, so the SW
    // stamps that from the frameId it routed to (later slice-13 SW task). Tag results from the top
    // frame so `query`/`screenshot`/`readImages` carry their frame; absent already means top.
    const selfFrameId = window.top === window.self ? 0 : undefined;
    const tagFrame = (result: ToolResult): ToolResult =>
      selfFrameId !== undefined && result.frameId === undefined
        ? { ...result, frameId: selfFrameId }
        : result;

    // Debug engine, content half (slice 06): buffer runtime/network signals for the whole page
    // lifetime and push each one to the SW as it's captured — a debug-mode turn observes as the
    // user drives the page rather than waiting for an explicit `drain`. The SW aggregates these
    // (src/agent/diagnostics.ts); this collector never touches the page's own behavior beyond its
    // (fully restorable) hooks.
    const diagnostics = createDiagnosticsCollector({
      onSignal: (signal) => emit({ type: 'diagnostics-signal', signal }),
    });

    // `diagnostics` DomTool: `drain` hands back + clears the buffered runtime/network signals;
    // `scan` runs a fresh point-in-time a11y + layout pass (not buffered — always current).
    function runDiagnostics(action: DiagnosticsInput['action']): ToolResult {
      const signals =
        action === 'drain'
          ? diagnostics.drain()
          : [...scanA11y(document, window), ...scanLayout(document, window)];
      return { type: 'tool-result', ok: true, data: { signals } };
    }

    // Screenshot is split across worlds: content computes the crop rect (read.ts), the SW captures
    // + crops (only it has chrome.tabs.captureVisibleTab). Returns a base64 PNG data URL as
    // ToolResult.data for the agent's vision self-correction (slice 04).
    async function screenshot(selector?: string): Promise<ToolResult> {
      const el = selector ? queryOne(document, selector) : null;
      if (selector && !el) {
        return {
          type: 'tool-result',
          ok: false,
          error: `No element matches selector: ${selector}`,
        };
      }
      // Bring an off-screen target into view before the SW grabs the viewport, else captureVisibleTab
      // (which only sees the current viewport) crops to empty. Then settle a paint frame before
      // capture. Scroll is restored in `finally` so the tool stays a read even if the capture
      // round-trip rejects — never strand the page mid-scroll for the next tool or a later full-page
      // capture's restore-to-start (mirrors background.ts's full-page path). scrollIntoView scrolls
      // EVERY scrollable ancestor, so their offsets are snapshotted + restored too, not just the
      // window's. Skipped in child frames: there it can scroll the TOP document, which this frame
      // can't restore (cross-origin: can't even read it) — a frame-routed off-screen target keeps
      // the pre-existing empty-crop → full-frame fallback rather than gain an unrestorable mutation.
      const before = { x: window.scrollX, y: window.scrollY };
      let ancestors: { el: Element; top: number; left: number }[] = [];
      let scrolled = false;
      if (
        el &&
        selfFrameId === 0 &&
        typeof el.scrollIntoView === 'function' &&
        needsScrollIntoView(el.getBoundingClientRect(), window.innerWidth, window.innerHeight)
      ) {
        ancestors = scrollableAncestors(el).map((a) => ({
          el: a,
          top: a.scrollTop,
          left: a.scrollLeft,
        }));
        el.scrollIntoView({ block: 'center', inline: 'center' });
        // Not abort-aware, unlike the stitch's browseDelay: tool messages carry no AbortSignal
        // (contentDispatchFor checks it only pre-send), so there's nothing to thread here —
        // bounded at SCROLL_SETTLE_MS + one capture round-trip.
        await new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_MS));
        scrolled = true;
      }
      try {
        const { rect, devicePixelRatio } = screenshotRect(el);
        const request: CaptureRequest = { type: 'capture-visible-tab', rect, devicePixelRatio };
        const parsed = CaptureResult.safeParse(await chrome.runtime.sendMessage(request));
        if (!parsed.success) {
          return { type: 'tool-result', ok: false, error: 'Malformed capture result from the SW' };
        }
        const { ok, dataUrl, error } = parsed.data;
        return ok && dataUrl
          ? { type: 'tool-result', ok: true, data: dataUrl }
          : { type: 'tool-result', ok: false, error: error ?? 'Screenshot capture failed' };
      } finally {
        if (scrolled) {
          for (const a of ancestors) {
            a.el.scrollTop = a.top;
            a.el.scrollLeft = a.left;
          }
          window.scrollTo(before.x, before.y);
        }
      }
    }

    // Serialize page-driving tools per frame: the AI SDK executes same-step tool calls concurrently
    // and the SW dispatches each call independently, so without this two scroll-moving calls (two
    // screenshots, or a screenshot between a full-page stitch's bands — its scrollTo rides
    // handleControl) interleave their scroll/restore and strand the page at a wrong offset. Pure
    // reads (describe / responsive / page-metrics / design-read) stay off the queue so they never
    // wait behind a settle or a stitch.
    let toolQueue: Promise<unknown> = Promise.resolve();
    function enqueue<T>(run: () => Promise<T>): Promise<T> {
      const result = toolQueue.then(run, run);
      toolQueue = result.catch(() => {});
      return result;
    }

    function handleTool(tool: DomTool): Promise<ToolResult> {
      if (tool.type === 'screenshot') return screenshot(tool.selector);
      if (tool.type === 'diagnostics') return Promise.resolve(runDiagnostics(tool.action));
      return Promise.resolve(executor.exec(tool));
    }

    // Browser-control tools (slice 13) + complex-site reads/actions (slice 15): `readImages` is a
    // pure read (src/dom/images.ts); `pageFacts`/`readChart`/`chartTooltip`/`widgetAct` proxy to
    // the slice-15 modules; the rest are page-driving actions handed to the interaction engine
    // (src/dom/interact.ts). All keep the entrypoint a thin wire — resolution + logic live in the
    // jsdom-tested dom modules.
    async function handleControl(tool: ControlTool): Promise<ToolResult> {
      if (tool.type === 'readImages') {
        const scope = tool.selector ? queryOne(document, tool.selector) : document;
        if (tool.selector && !scope) {
          const error = `No element matches selector: ${tool.selector}`;
          return { type: 'tool-result', ok: false, error };
        }
        const data: ReadImagesResult = readImages(scope ?? document, window);
        return { type: 'tool-result', ok: true, data };
      }
      if (tool.type === 'pageFacts') {
        return { type: 'tool-result', ok: true, data: await pageFacts.get() };
      }
      if (tool.type === 'readChart') {
        return { type: 'tool-result', ok: true, data: await chartReader.read(tool.selector) };
      }
      if (tool.type === 'chartTooltip') {
        const data = await chartReader.readTooltip(tool.selector);
        return { type: 'tool-result', ok: true, data };
      }
      if (tool.type === 'widgetAct') {
        return widgetDriver.run(tool.recipe);
      }
      return interactor.run(tool);
    }

    // Describe-in-text + design-identity reads (slice 14): all pure DOM, routed to the tested
    // src/dom modules. `describe` text modes → describePage; `extractIdentity` → the identity
    // extractor; `readImageContent` → the image's alt/src (the SW adds the vision prose). `scene`
    // describe is a vision call the SW owns, so it never reaches content — guarded defensively.
    function handleDescribe(cmd: DescribeCmd): ToolResult {
      if (cmd.type === 'extractIdentity') {
        const data: IdentityResult = extractIdentity(document, window);
        return { type: 'tool-result', ok: true, data };
      }
      if (cmd.type === 'readImageContent') {
        const img = imageContent(document, cmd.selector, window);
        if (!img) {
          const error = `No element matches selector: ${cmd.selector}`;
          return { type: 'tool-result', ok: false, error };
        }
        const data: ImageDescription = {
          selector: img.selector,
          src: img.src,
          ...(img.alt !== undefined ? { alt: img.alt } : {}),
          description: img.alt ?? '',
        };
        return { type: 'tool-result', ok: true, data };
      }
      if (cmd.mode === 'scene') {
        const error = 'Scene description needs the vision model — it runs in the service worker.';
        return { type: 'tool-result', ok: false, error };
      }
      const root = cmd.selector ? queryOne(document, cmd.selector) : document;
      if (cmd.selector && !root) {
        const error = `No element matches selector: ${cmd.selector}`;
        return { type: 'tool-result', ok: false, error };
      }
      const data: DescribeResult = describePage(root ?? document, cmd.mode);
      return { type: 'tool-result', ok: true, data };
    }

    // Responsive problem scan (slice 16): run the content-world scanner at the current — possibly
    // emulated (the SW set a device via CDP/fallback) — viewport width. Pure DOM read
    // (src/dom/responsive.ts, jsdom-tested); `selector` scopes it to a subtree.
    function handleResponsive(cmd: CheckResponsiveInput): ToolResult {
      const root = cmd.selector ? queryOne(document, cmd.selector) : document;
      if (cmd.selector && !root) {
        return {
          type: 'tool-result',
          ok: false,
          error: `No element matches selector: ${cmd.selector}`,
        };
      }
      const data: CheckResponsiveResult = scanResponsive(document, window, {
        root: root ?? document,
      });
      return { type: 'tool-result', ok: true, data };
    }

    // The SW addresses this tab with three message kinds: agent DomTool + ControlTool calls (reply
    // with a frame-tagged ToolResult) and user-driven PickerCmds (start/stop the overlay, no
    // reply). Parse each with its own schema; anything else is a foreign message and is ignored.
    chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      // Cross-site browse (slice 06): the SW opened this page in a background tab and wants its
      // compact design identity. Pure DOM read (src/dom/design-read.ts); reply with a typed result
      // (an extraction failure degrades to an error the SW surfaces, never a dropped response).
      const design = DesignReadRequest.safeParse(raw);
      if (design.success) {
        try {
          const read = extractDesignRead(document, window, { maxColors: design.data.maxColors });
          sendResponse({ type: 'design-read-result', ok: true, read } satisfies DesignReadResult);
        } catch (err) {
          sendResponse({ type: 'design-read-result', ok: false, error: String(err) });
        }
        return; // responded synchronously
      }

      // Full-page capture (slice 13): the SW scroll-stitches viewport grabs (only it has
      // captureVisibleTab + OffscreenCanvas) and needs this frame's scroll/viewport geometry to plan
      // the bands. Pure DOM read (src/dom/read.ts); a failure degrades to an error the SW surfaces.
      const metrics = PageMetricsRequest.safeParse(raw);
      if (metrics.success) {
        try {
          sendResponse({
            type: 'page-metrics-result',
            ok: true,
            metrics: pageMetrics(document, window),
          } satisfies PageMetricsResult);
        } catch (err) {
          sendResponse({ type: 'page-metrics-result', ok: false, error: String(err) });
        }
        return; // responded synchronously
      }

      // Always answer a tool call: a rejected round-trip (e.g. the SW evicted mid-screenshot)
      // degrades to an error ToolResult the agent reacts to, never a dropped response / unhandled
      // reject. Replies are frame-tagged so the SW can compose iframe coordinates.
      const answer = (run: Promise<ToolResult>): true => {
        run
          .then((result) => sendResponse(tagFrame(result)))
          .catch((err) => sendResponse({ type: 'tool-result', ok: false, error: String(err) }));
        return true; // async ToolResult
      };

      const tool = DomTool.safeParse(raw);
      if (tool.success) return answer(enqueue(() => handleTool(tool.data)));

      const control = ControlTool.safeParse(raw);
      if (control.success) return answer(enqueue(() => handleControl(control.data)));

      const describeCmd = DescribeCmd.safeParse(raw);
      if (describeCmd.success) return answer(Promise.resolve(handleDescribe(describeCmd.data)));

      const responsive = CheckResponsiveInput.safeParse(raw);
      if (responsive.success) return answer(Promise.resolve(handleResponsive(responsive.data)));

      const cmd = PickerCmd.safeParse(raw);
      if (cmd.success) {
        if (cmd.data.type === 'picker-start') picker.start();
        else picker.stop();
        return;
      }

      const overlayCmd = OverlayCmd.safeParse(raw);
      if (overlayCmd.success) {
        if (overlayCmd.data.type === 'overlay-toggle') overlay.toggle(overlayCmd.data.enabled);
        else {
          overlay.step({
            label: overlayCmd.data.label,
            selector: overlayCmd.data.selector,
            kind: overlayCmd.data.kind,
          });
        }
      }
      return; // no response for picker/overlay commands / foreign messages
    });

    // Complex-site lifecycle (slice 15A/F): warm the page-facts cache + observe SPA route changes.
    // Only the top frame runs this — a page's SPA navigation + framework stack are top-document
    // concerns. The bridge is read-only + non-secret (src/dom/bridge.ts): MAIN == the page's own
    // world, so no key ever crosses; page-facts falls back to DOM-only when it's unreachable.
    if (window.top === window.self) {
      // Warm the per-URL facts cache once the SPA has hydrated + settled (first agent query is then
      // instant); re-derive on client-side route changes (pushState/popstate/hash) that never reload.
      const deriveFacts = (): void => {
        void waitForQuiescence(window, document).then(() => pageFacts.get());
      };
      deriveFacts();
      const routes = createRouteObserver(() => {
        pageFacts.invalidate();
        deriveFacts();
      });
      window.addEventListener(
        'pagehide',
        () => {
          routes.dispose();
          bridge.dispose();
        },
        { once: true },
      );
    }
  },
});
