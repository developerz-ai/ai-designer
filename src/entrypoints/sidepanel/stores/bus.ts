import type { z } from 'zod';
import type { PanelToSw, SwToPanel } from '@/shared/messages';
import { PORT_NAME, parseSwToPanel } from '@/shared/port';

// Thin panel -> service-worker RPC: send a typed message, validate the reply
// against its schema. Keeps chrome.* out of components and stores (SRP), and
// guarantees the panel never trusts an unshaped SW response.
export async function request<T>(msg: PanelToSw, schema: z.ZodType<T>): Promise<T> {
  const raw = await chrome.runtime.sendMessage(msg);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Malformed service-worker response for "${msg.type}"`);
  }
  return parsed.data;
}

// --- Panel -> SW push stream (long-lived Port) -----------------------------
// Subscribers are the only public surface; the Port itself is held privately.
const subscribers = new Set<(msg: SwToPanel) => void>();
let connected = false;
let port: chrome.runtime.Port | null = null;

// Open the long-lived Port to the service worker. Idempotent: safe to call on
// every panel mount. Malformed inbound messages are silently dropped.
export function connectPort(): void {
  if (connected) {
    return;
  }
  connected = true;
  port = chrome.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener((raw) => {
    const parsed = parseSwToPanel(raw);
    if (parsed) {
      for (const fn of subscribers) {
        fn(parsed);
      }
    }
  });
}

// Register a handler for validated SW -> panel messages. Returns an unsubscribe
// closure.
export function subscribeToSw(handler: (msg: SwToPanel) => void): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}
