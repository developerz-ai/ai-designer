import type { z } from 'zod';
import { i18n } from '#i18n';
import type { PanelToSw } from '@/shared/messages';

// Thin panel -> service-worker RPC: send a typed message, validate the reply
// against its schema. Keeps chrome.* out of components and stores (SRP), and
// guarantees the panel never trusts an unshaped SW response. This module is
// request/reply ONLY — the SW -> panel push stream is a sibling (stores/sw-stream.ts).
export async function request<T>(msg: PanelToSw, schema: z.ZodType<T>): Promise<T> {
  const raw = await chrome.runtime.sendMessage(msg);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(i18n.t('bus.error.malformedResponse', { type: msg.type }));
  }
  return parsed.data;
}
