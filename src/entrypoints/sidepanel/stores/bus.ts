import type { z } from 'zod';
import type { PanelToSw } from '@/shared/messages';

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
