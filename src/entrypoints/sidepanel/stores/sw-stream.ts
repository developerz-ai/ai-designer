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
let connected = false;

// Open the long-lived Port to the service worker. Idempotent: safe to call on
// every panel mount. Malformed inbound messages are silently dropped.
export function connectPort(): void {
  if (connected) {
    return;
  }
  connected = true;
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
}

// Register a handler for validated SW -> panel messages. Returns an unsubscribe
// closure. Handlers persist across Port reconnects.
export function subscribeToSw(handler: (msg: SwToPanel) => void): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}
