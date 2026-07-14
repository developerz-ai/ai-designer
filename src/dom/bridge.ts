import { BRIDGE_SOURCE, type BridgeMethod, BridgeRequest, BridgeResponse } from '@/shared/messages';

// The MAIN-world bridge — transport for the isolated content world to call the page's own JS world
// (`src/entrypoints/injected.content.ts`). Only the MAIN world can read page globals (framework
// internals, chart-lib instances); it answers a NARROW, READ-ONLY RPC over `window.postMessage`,
// guarded by an origin + `source === window` + per-request nonce check. NOTHING secret ever crosses
// — MAIN == the page's own, untrusted world (CLAUDE.md "MV3 three worlds", docs/architecture/
// security.md). Both halves are pure DOM (postMessage + addEventListener), so they run under jsdom /
// a fake window and stay coverage-counted; the two entrypoints hosting them (content.ts client,
// injected.content.ts server) stay thin wires.
//
// The `dir` discriminant lets each side ignore its own echoes: a self-post reaches BOTH worlds'
// listeners, so the client drops `req` messages and the server drops `res` messages.

type TimerHandle = ReturnType<typeof setTimeout>;

const DEFAULT_TIMEOUT_MS = 2000;

// `window.postMessage` targetOrigin: pin to our own origin so a self-post is only ever delivered
// same-origin. An opaque origin serializes to the string 'null', which is NOT a valid targetOrigin
// (it throws) — fall back to '*' there (delivery is still same-window-only, and the payload is
// non-secret + re-validated on receipt).
function targetOriginFor(win: Window): string {
  const origin = win.location.origin;
  return origin && origin !== 'null' ? origin : '*';
}

// A message is ours + trustworthy only if it came from THIS window (not an embedded frame) at our
// own origin. These two checks — not the nonce — are the real guard against a spoofed reply.
function fromSameWindow(event: MessageEvent, win: Window): boolean {
  return event.source === win && event.origin === win.location.origin;
}

function defaultNonce(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `n-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

// --- client (content world) ----------------------------------------------

export interface Bridge {
  /** Call a read-only MAIN-world method; resolves with its raw `result` (the caller validates the
   *  shape), rejects on an `ok:false` reply or a timeout (a missing / slow MAIN world). */
  request(method: BridgeMethod): Promise<unknown>;
  /** Remove the listener + reject any in-flight request (page teardown / tests). */
  dispose(): void;
}

export interface BridgeClientOptions {
  /** Window whose MAIN world hosts the server — defaults to the ambient `window`. */
  readonly win?: Window;
  /** Reject a pending request after this many ms with no matching reply (default 2000). */
  readonly timeoutMs?: number;
  /** Fresh per-request nonce (default `crypto.randomUUID`); injectable for deterministic tests. */
  readonly nonce?: () => string;
  /** Timer scheduler — injectable so tests can drive the timeout deterministically. */
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
}

export function createBridge(options: BridgeClientOptions = {}): Bridge {
  const win = options.win ?? window;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nextNonce = options.nonce ?? defaultNonce;
  const setTimer = options.setTimer ?? ((fn, ms): TimerHandle => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle): void => clearTimeout(handle));

  interface Pending {
    readonly resolve: (result: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: TimerHandle;
  }
  const pending = new Map<string, Pending>();

  const settle = (nonce: string): Pending | undefined => {
    const entry = pending.get(nonce);
    if (!entry) return undefined;
    pending.delete(nonce);
    clearTimer(entry.timer);
    return entry;
  };

  const onMessage = (event: MessageEvent): void => {
    if (!fromSameWindow(event, win)) return;
    const parsed = BridgeResponse.safeParse(event.data);
    if (!parsed.success) return; // not a bridge response / our own `req` echo — ignore
    const { nonce, ok, result, error } = parsed.data;
    const entry = settle(nonce);
    if (!entry) return; // unknown / already-settled nonce — stale or spoofed, ignore
    if (ok) entry.resolve(result);
    else entry.reject(new Error(error ?? 'Bridge method failed'));
  };
  win.addEventListener('message', onMessage);

  const request = (method: BridgeMethod): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      const nonce = nextNonce();
      const timer = setTimer(() => {
        pending.delete(nonce);
        reject(new Error(`Bridge request timed out: ${method}`));
      }, timeoutMs);
      pending.set(nonce, { resolve, reject, timer });
      const message: BridgeRequest = { source: BRIDGE_SOURCE, dir: 'req', nonce, method };
      win.postMessage(message, targetOriginFor(win));
    });

  const dispose = (): void => {
    win.removeEventListener('message', onMessage);
    for (const entry of pending.values()) {
      clearTimer(entry.timer);
      entry.reject(new Error('Bridge disposed'));
    }
    pending.clear();
  };

  return { request, dispose };
}

// --- server (MAIN world) --------------------------------------------------

/** A read-only handler for one bridge method — returns the (non-secret) payload, sync or async. */
export type BridgeHandler = () => unknown;

export type BridgeHandlers = Partial<Record<BridgeMethod, BridgeHandler>>;

export interface BridgeServer {
  dispose(): void;
}

export interface BridgeServerOptions {
  /** Window to serve on — defaults to the ambient `window` (the MAIN world's page window). */
  readonly win?: Window;
}

// Runs in the MAIN world (`src/entrypoints/injected.content.ts`). Answers requests from the content
// world's `createBridge` client: validates the message is same-window + same-origin + a well-formed
// `BridgeRequest`, runs the matching read-only handler, and posts the result back with the request's
// nonce. Unknown methods + handler errors reply `ok:false` (never throw into the page's message loop).
export function serveBridge(
  handlers: BridgeHandlers,
  options: BridgeServerOptions = {},
): BridgeServer {
  const win = options.win ?? window;

  const reply = (nonce: string, body: Omit<BridgeResponse, 'source' | 'dir' | 'nonce'>): void => {
    const message: BridgeResponse = { source: BRIDGE_SOURCE, dir: 'res', nonce, ...body };
    win.postMessage(message, targetOriginFor(win));
  };

  const onMessage = (event: MessageEvent): void => {
    if (!fromSameWindow(event, win)) return;
    const parsed = BridgeRequest.safeParse(event.data);
    if (!parsed.success) return; // not a bridge request / our own `res` echo — ignore
    const { method, nonce } = parsed.data;
    const handler = handlers[method];
    if (!handler) {
      reply(nonce, { ok: false, error: `Unknown bridge method: ${method}` });
      return;
    }
    // A handler may be sync or async and runs against the untrusted page — never let it throw into
    // the page's message loop; surface any failure as an `ok:false` reply the client rejects on.
    void Promise.resolve()
      .then(() => handler())
      .then((result) => reply(nonce, { ok: true, result }))
      .catch((error: unknown) => reply(nonce, { ok: false, error: String(error) }));
  };
  win.addEventListener('message', onMessage);

  return { dispose: (): void => win.removeEventListener('message', onMessage) };
}
