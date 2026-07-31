import type { SwToPanel } from '@/shared/messages';
import { PORT_NAME, parseSwToPanel } from '@/shared/port';

// Panel <- service-worker push stream over a long-lived chrome.runtime Port.
// bus.ts stays request/reply-only (SRP); this is its sibling for the
// fire-and-forget SW -> panel direction. Subscribers are the only public
// surface; the Port is held privately and re-opened when the SW is evicted.

// Delay before re-opening a dropped Port. MV3 service workers are non-persistent
// (idle eviction, the ~5-min connected-port cap, memory pressure), so an open
// panel WILL see its Port disconnect mid-session; the small backoff avoids a hot
// reconnect loop if the SW is momentarily unavailable.
const RECONNECT_DELAY_MS = 500;

const subscribers = new Set<(msg: SwToPanel) => void>();
// Fired after a DROPPED Port is re-opened (never on the first connect). Subscribers survive a
// reconnect untouched (test/integration/transport.test.ts), but the SNAPSHOTS the stores pulled
// once on mount do not: the SW's live MCP health, readiness and session state are in-memory and
// reset when the worker restarts, so a panel that only re-subscribes keeps rendering the state of
// a worker that no longer exists (a "connected" backend row with its Connect button hidden). Each
// store registers its own hydration here (#165 S5).
const reconnectHandlers = new Set<() => void>();
let connected = false;
let everConnected = false;

// Open the long-lived Port to the service worker. Idempotent: safe to call on
// every panel mount. Malformed inbound messages are silently dropped.
export function connectPort(): void {
  if (connected) {
    return;
  }
  const port = chrome.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener((raw) => {
    const parsed = parseSwToPanel(raw);
    if (!parsed) {
      return;
    }
    for (const fn of subscribers) {
      fn(parsed);
    }
  });
  port.onDisconnect.addListener(() => {
    // The SW was evicted or the Port closed. Reconnect so focus/picker updates
    // keep flowing across SW lifecycles. Subscribers live in module state, so
    // they survive the reconnect untouched.
    connected = false;
    setTimeout(connectPort, RECONNECT_DELAY_MS);
  });
  // Latch only after a successful connect + listener wiring: if connect() throws
  // (context invalidated), connected stays false so the next call can retry.
  connected = true;
  // Re-connect only — the first connect is the stores' own mount hydration, and firing here too
  // would double every hydration RPC on panel open.
  if (everConnected) {
    for (const fn of reconnectHandlers) fn();
  }
  everConnected = true;
}

// Register a handler for validated SW -> panel messages. Returns an unsubscribe
// closure. Handlers persist across Port reconnects.
export function subscribeToSw(handler: (msg: SwToPanel) => void): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}

// Register a snapshot re-hydration to run after every Port re-connect (see `reconnectHandlers`).
// Returns an unregister closure. Never fired for the initial connect.
export function onReconnect(handler: () => void): () => void {
  reconnectHandlers.add(handler);
  return () => {
    reconnectHandlers.delete(handler);
  };
}

// Fan a message the panel already holds out to the subscribers as if the SW had pushed it. The
// `session-get` reply carries exactly the facts of a `session-state` push, so replaying it keeps
// ONE fold per store (chat closes an orphaned bubble, changeset refreshes) instead of the session
// store reaching into its siblings. Only ever called with a value the SW just returned — the panel
// never invents stream content (CLAUDE.md "SolidJS + SRP": the SW is the source of truth).
export function publishLocal(msg: SwToPanel): void {
  for (const fn of subscribers) fn(msg);
}
