import { createSignal } from 'solid-js';
import { OverlayEnabledResult } from '@/shared/messages';
import { request } from './bus';

// On-page agent-decision overlay toggle (slice 09): thin reflection of the SW-persisted opt-in
// (background.ts's `set-overlay-enabled`/`get-overlay-enabled`, `src/shared/overlay-prefs.ts`).
// No push stream needed — this panel is the only writer, so a plain RPC round-trip on toggle stays
// in sync; `hydrateOverlayEnabled` covers the value on mount. CLAUDE.md "SolidJS + SRP": the
// toggle UI (ReadinessDropdown) reads `enabled()` and dispatches `setOverlayEnabled`, nothing else.

const [enabled, setEnabledSignal] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

export { enabled, error };

let wired = false;

/** Pull the current persisted opt-in on mount. Idempotent — safe to call on every mount. */
export function initOverlayStore(): void {
  if (wired) return;
  wired = true;
  void hydrateOverlayEnabled();
}

async function hydrateOverlayEnabled(): Promise<void> {
  try {
    const r = await request({ type: 'get-overlay-enabled' }, OverlayEnabledResult);
    setEnabledSignal(r.enabled);
  } catch (e) {
    setError(errMsg(e));
  }
}

/** Flip the opt-in. The SW persists it and immediately pushes the new state to the active tab's
 *  overlay (so an already-open page reflects it without a reload). */
export async function setOverlayEnabled(next: boolean): Promise<void> {
  setError(null);
  try {
    const r = await request({ type: 'set-overlay-enabled', enabled: next }, OverlayEnabledResult);
    setEnabledSignal(r.enabled);
  } catch (e) {
    setError(errMsg(e));
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
