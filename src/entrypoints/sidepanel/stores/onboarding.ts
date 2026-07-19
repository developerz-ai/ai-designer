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
//
// Persistence is best-effort: the actions swallow RPC failures rather than surface them (a failed
// save just re-shows the guide next open — no data loss, and nothing renders an error on a screen
// the user is dismissing), so there is no write-only `error` signal to read.

const [visible, setVisible] = createSignal(false);

export { visible };

let wired = false;

/** Pull the persisted dismissed flag on mount and auto-show the guide when it has never been
 *  dismissed. Idempotent — safe to call on every mount. */
export function initOnboardingStore(): void {
  if (wired) return;
  wired = true;
  void hydrateOnboarding();
}

// Auto-SHOW only — reveal the guide when it has never been dismissed, but NEVER set visible false
// here: a late-resolving mount RPC must not clobber an `openOnboarding()` the user just triggered
// from Settings. `visible` defaults false, so "not dismissed" is the only nudge hydrate needs.
async function hydrateOnboarding(): Promise<void> {
  try {
    const r = await request({ type: 'get-onboarding-dismissed' }, OnboardingStateResult);
    if (!r.dismissed) setVisible(true);
  } catch {
    // Best-effort: a failed read leaves the guide hidden (the safe default); the user can still
    // open it from Settings.
  }
}

/** Skip or finish: persist dismissed=true (won't auto-show again) and hide. */
export async function dismissOnboarding(): Promise<void> {
  setVisible(false);
  try {
    await request({ type: 'set-onboarding-dismissed', dismissed: true }, OnboardingStateResult);
  } catch {
    // Best-effort persist: if the write fails the guide simply re-appears next open — no data loss.
  }
}

/** A step CTA jumped the user to Settings/MCP: hide the overlay without persisting, so the
 *  guide returns on the next panel open showing the new progress. */
export function hideOnboarding(): void {
  setVisible(false);
}

/** Settings "Show setup guide": re-open without touching the persisted flag. */
export function openOnboarding(): void {
  setVisible(true);
}
