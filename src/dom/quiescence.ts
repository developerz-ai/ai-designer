// Hydration + quiescence awaiting and SPA route-change observation (slice 15A) — the content world's
// "is the page ready to read/act on yet, and did it just navigate?" primitives. Real apps hydrate
// async and re-render on client-side navigation, so the agent must await a settled DOM before deriving
// page-facts or driving a widget, and re-derive when an SPA swaps routes without a full load. Pure DOM
// + injected window/document/timers (no chrome.*), so every branch runs under jsdom and the content
// entrypoint (coverage-excluded) stays a thin wire. Nothing here is secret — it observes structure +
// navigation only.

type TimerHandle = ReturnType<Window['setTimeout']>;

export interface QuiescenceResult {
  /** A genuine quiet window was observed (the DOM stopped mutating) before the timeout. */
  readonly quiescent: boolean;
  /** The hard timeout fired first — the page never settled (act anyway, flagged). */
  readonly timedOut: boolean;
  readonly elapsedMs: number;
}

export interface QuiescenceDeps {
  /** No-mutation window that counts as settled (default 500ms). */
  readonly quietMs?: number;
  /** Hard cap so a perpetually-animating page can't hang the turn (default 10_000ms). */
  readonly timeoutMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
  readonly now?: () => number;
  /** Subscribe to DOM-change signals; returns an unsubscribe. Default: a `MutationObserver` on the
   *  document element. Injectable so tests drive mutations deterministically. */
  readonly observe?: (onChange: () => void) => () => void;
  /** Whether parsing/hydration has finished. Default: `document.readyState === 'complete'`. */
  readonly isReady?: () => boolean;
  /** Subscribe to readiness; returns an unsubscribe. Default: a `readystatechange`/`load` listener. */
  readonly onReady?: (cb: () => void) => () => void;
}

const DEFAULT_QUIET_MS = 500;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Resolve once the page has hydrated AND its DOM has been quiet for `quietMs`, or when `timeoutMs`
 * elapses first (a page that never settles resolves `quiescent:false` so the agent still acts). The
 * quiet window only starts once the document is ready, so async hydration mutations keep resetting it
 * rather than counting as "settled early". Every timer + subscription is torn down on settle — no leak.
 */
export function waitForQuiescence(
  win: Window,
  doc: Document,
  deps: QuiescenceDeps = {},
): Promise<QuiescenceResult> {
  const quietMs = deps.quietMs ?? DEFAULT_QUIET_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const setTimer = deps.setTimer ?? ((fn, ms): TimerHandle => win.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: TimerHandle): void => win.clearTimeout(handle));
  const now = deps.now ?? ((): number => win.performance?.now?.() ?? 0);
  const isReady = deps.isReady ?? ((): boolean => doc.readyState === 'complete');
  const observe = deps.observe ?? defaultObserve(doc);
  const onReady = deps.onReady ?? defaultOnReady(doc, win);

  const started = now();
  return new Promise<QuiescenceResult>((resolve) => {
    let done = false;
    let begun = false;
    let quiet: TimerHandle | undefined;
    let unobserve: (() => void) | undefined;
    let unready: (() => void) | undefined;

    const finish = (quiescent: boolean): void => {
      if (done) return;
      done = true;
      if (quiet !== undefined) clearTimer(quiet);
      clearTimer(hard);
      unobserve?.();
      unready?.();
      resolve({ quiescent, timedOut: !quiescent, elapsedMs: Math.round(now() - started) });
    };

    const armQuiet = (): void => {
      if (quiet !== undefined) clearTimer(quiet);
      quiet = setTimer(() => finish(true), quietMs);
    };

    // Start counting only once hydrated: every mutation until then (and after) resets the window.
    const begin = (): void => {
      if (begun || done) return;
      begun = true;
      unready?.();
      unready = undefined;
      unobserve = observe(armQuiet);
      armQuiet();
    };

    const hard = setTimer(() => finish(false), timeoutMs);
    if (isReady()) begin();
    else unready = onReady(begin);
  });
}

function defaultObserve(doc: Document): (onChange: () => void) => () => void {
  return (onChange): (() => void) => {
    if (typeof MutationObserver !== 'function') return (): void => {};
    const target = doc.documentElement ?? doc;
    const observer = new MutationObserver(() => onChange());
    observer.observe(target, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    return (): void => observer.disconnect();
  };
}

function defaultOnReady(doc: Document, win: Window): (cb: () => void) => () => void {
  return (cb): (() => void) => {
    const handler = (): void => {
      if (doc.readyState === 'complete') cb();
    };
    doc.addEventListener('readystatechange', handler);
    win.addEventListener('load', handler, { once: true });
    return (): void => {
      doc.removeEventListener('readystatechange', handler);
      win.removeEventListener('load', handler);
    };
  };
}

// --- SPA route-change observation -----------------------------------------

/** The Navigation API surface we opportunistically use (Chromium) — same-document nav fires `navigate`.
 *  Typed narrowly so its absence (jsdom, older browsers) is a guarded no-op, never an `any`. */
interface NavigationLike {
  addEventListener?: (type: 'navigate', cb: () => void) => void;
  removeEventListener?: (type: 'navigate', cb: () => void) => void;
}

export interface RouteObserverDeps {
  /** Window to observe — defaults to the ambient `window`. */
  readonly win?: Window;
  /** `location.href` poll interval — the cross-world safety net for a page-driven `pushState` the
   *  isolated content world's listeners can't otherwise see (default 1000ms; 0 disables the poll). */
  readonly pollMs?: number;
  readonly setPoll?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearPoll?: (handle: TimerHandle) => void;
}

export interface RouteObserver {
  /** Stop observing + restore listeners (page teardown / tests). */
  dispose(): void;
}

function hrefOf(win: Window): string {
  try {
    return win.location.href;
  } catch {
    return '';
  }
}

/**
 * Fire `onChange(newHref)` on a client-side (same-document) navigation — an SPA route swap that never
 * triggers a full page load. Draws on every signal that reaches the isolated content world: `popstate`
 * + `hashchange`, the Navigation API's `navigate` where present, and a bounded `location.href` poll as
 * the catch-all for framework `pushState` (which the page performs in its OWN JS world, invisible to a
 * content-world history patch). De-duped on the href so one navigation fires once, whichever signal won.
 */
export function createRouteObserver(
  onChange: (url: string) => void,
  deps: RouteObserverDeps = {},
): RouteObserver {
  const win = deps.win ?? window;
  const pollMs = deps.pollMs ?? 1000;
  const setPoll = deps.setPoll ?? ((fn, ms): TimerHandle => win.setInterval(fn, ms));
  const clearPoll = deps.clearPoll ?? ((handle: TimerHandle): void => win.clearInterval(handle));

  let lastHref = hrefOf(win);
  const check = (): void => {
    const href = hrefOf(win);
    if (href === lastHref) return;
    lastHref = href;
    onChange(href);
  };

  win.addEventListener('popstate', check);
  win.addEventListener('hashchange', check);

  const nav = (win as unknown as { navigation?: NavigationLike }).navigation;
  nav?.addEventListener?.('navigate', check);

  const poll = pollMs > 0 ? setPoll(check, pollMs) : undefined;

  return {
    dispose(): void {
      win.removeEventListener('popstate', check);
      win.removeEventListener('hashchange', check);
      nav?.removeEventListener?.('navigate', check);
      if (poll !== undefined) clearPoll(poll);
    },
  };
}
