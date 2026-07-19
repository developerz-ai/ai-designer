import { createSignal } from 'solid-js';
import { OnboardingStateResult } from '@/shared/messages';
import { request } from './bus';

// First-run onboarding visibility (slice 24): thin reflection of the SW-persisted "dismissed"
// flag (background.ts's `get`/`set-onboarding-dismissed`, `src/shared/onboarding-prefs.ts`).
// The panel is the only writer, so a plain RPC round-trip keeps it in sync — no push stream.
// CLAUDE.md "SolidJS + SRP": the component reads `visible()` and dispatches these actions,
// nothing else.
//
// Three exits, two persistence semantics:
//  - `dismissOnboarding()` — Skip / "Get started": persist dismissed=true so it never auto-shows
//    again.
//  - `hideOnboarding()`    — a step's "Fix" CTA: hide for now WITHOUT persisting, so the guide
//    re-appears on the next panel open with the just-completed step checked off (criterion:
//    "guides setup"). Re-openable immediately from Settings meanwhile.
//  - `openOnboarding()`    — Settings re-entry: show it again without changing the flag.

const [visible, setVisible] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

export { error, visible };

let wired = false;

/** Pull the persisted dismissed flag on mount and auto-show the guide when it has never been
 *  dismissed. Idempotent — safe to call on every mount. */
export function initOnboardingStore(): void {
  if (wired) return;
  wired = true;
  void hydrateOnboarding();
}

async function hydrateOnboarding(): Promise<void> {
  try {
    const r = await request({ type: 'get-onboarding-dismissed' }, OnboardingStateResult);
    setVisible(!r.dismissed);
  } catch (e) {
    setError(errMsg(e));
  }
}

/** Skip or finish: persist dismissed=true (won't auto-show again) and hide. */
export async function dismissOnboarding(): Promise<void> {
  setError(null);
  setVisible(false);
  try {
    await request({ type: 'set-onboarding-dismissed', dismissed: true }, OnboardingStateResult);
  } catch (e) {
    setError(errMsg(e));
  }
}

/** A step CTA jumped the user to Settings/MCP: hide the overlay without persisting, so the
 *  guide returns on the next panel open showing the new progress. */
export function hideOnboarding(): void {
  setVisible(false);
}

/** Settings "Show setup guide": re-open without touching the persisted flag. */
export function openOnboarding(): void {
  setError(null);
  setVisible(true);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
