// The session tri-state, persisted so it survives service-worker eviction (#165 S5).
//
// THE GAP THIS CLOSES: `background.ts` held the Start/Stop tri-state in a module-level `let` and
// only ever PUSHED transitions. The SW is killed after ~30s idle, and a turn can stall without
// stream traffic (a slow provider, a 30s `waitFor`, a `chrome.debugger.attach` awaiting a user
// prompt). The panel then reconnects to a cold worker that believes the state is `idle`, pushes
// nothing, and offers no way to ask — while the panel's in-flight assistant bubble is only ever
// closed by `turn-done` / `error` / a non-running `session-state`, none of which will now arrive.
// A permanently spinning, half-written message.
//
// Two facts are persisted, because they answer two different questions:
//   • the LIFECYCLE (here) — "is the user in a session at all?", worker-wide.
//   • the per-tab `TurnSession.status` (`src/agent/session.ts`) — "was a turn running on this
//     tab?". The schema already modelled it and nothing ever wrote anything but `'idle'`.
// `reconcileTurnStatus` below is what turns the second into a truthful answer after a wake.
//
// SW-ONLY (touches `chrome.storage.session`); never import from content.ts.

import { SessionLifecycle } from '@/shared/messages';
import type { TurnStatus } from './session';

// Deliberately NOT under the `session:` prefix: `SessionStore.hydrate()` claims that whole
// namespace and REMOVES any key there that doesn't validate as a `TurnSession`, so a
// `session:lifecycle` key would be deleted on the very wake it exists to survive.
const STORAGE_KEY = 'sessionLifecycle';

/** The persisted lifecycle, or `'idle'` for a fresh install / unreadable record. Never throws —
 *  a storage hiccup must not brick the panel's reconnect path. */
export async function readSessionLifecycle(): Promise<SessionLifecycle> {
  try {
    const got = await chrome.storage.session.get(STORAGE_KEY);
    const parsed = SessionLifecycle.safeParse(got[STORAGE_KEY]);
    return parsed.success ? parsed.data : 'idle';
  } catch {
    return 'idle';
  }
}

/** Persist the lifecycle. Best-effort: a failed write only degrades a later wake to `'idle'`,
 *  which is the pre-#165 behaviour, and must never fail the RPC that triggered it. */
export async function writeSessionLifecycle(state: SessionLifecycle): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: state });
  } catch {
    // See above.
  }
}

/**
 * What a tab's persisted turn status really means right now (pure).
 *
 * A persisted `'running'` with no turn in flight in THIS worker can only mean the turn died with an
 * evicted service worker — a woken worker never resumes a turn. Report (and heal it to) `'stopped'`:
 * that is exactly the "aborted, session still open" state, and it is what lets the panel close the
 * orphaned in-flight bubble instead of spinning forever. Every other combination passes through.
 */
export function reconcileTurnStatus(
  persisted: TurnStatus | undefined,
  turnRunning: boolean,
): TurnStatus {
  if (turnRunning) return 'running';
  return persisted === 'running' ? 'stopped' : (persisted ?? 'idle');
}
