// Chrome-free SW<->panel Port primitives: the shared port name + a Zod gate for
// inbound SW->panel messages. No chrome.* here — pure string + Zod so this is
// importable by both the side panel and unit tests without a chrome mock.

export const PORT_NAME = 'dz-sw-panel';

// Value alias satisfies verbatimModuleSyntax (type-only import elided at emit,
// runtime schema kept). Mirrors background.ts PanelToSw.safeParse gate.
import { type SwToPanel, SwToPanel as SwToPanelSchema } from './messages';

export function parseSwToPanel(raw: unknown): SwToPanel | null {
  const r = SwToPanelSchema.safeParse(raw);
  return r.success ? r.data : null;
}
