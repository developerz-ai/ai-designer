import { createSignal } from 'solid-js';
import { requestPageAccess } from '@/shared/host-permissions';
import type { SwToPanel } from '@/shared/messages';
import { OkResult, SessionStateResult } from '@/shared/messages';
import { request } from './bus';
import { connectPort, onReconnect, publishLocal, subscribeToSw } from './sw-stream';

// Session store: thin reflection of the SW's Start/Stop lifecycle (background.ts's
// `session-start`/`session-stop` RPCs + the unsolicited `session-state` push from
// `setSessionState`). `idle` -> `running` (session-start) -> `stopped` (session-stop
// aborted the in-flight turn; the session itself stays open — see `SessionStart`/
// `SessionStop` in src/shared/messages.ts). App.tsx derives its `sessionStarted` gate as
// `sessionState() !== 'idle'`, so a stopped turn keeps ChatPanel mounted for the next
// message rather than bouncing the panel back to the pre-Start state.

export type SessionState = 'idle' | 'running' | 'stopped';

/** Pure fold: apply one SW->panel message onto the session state. Unrelated message
 *  types are a no-op (identity). Exported for a mock-free unit test, mirroring
 *  stores/readiness.ts's `reduceReadiness`. */
export function reduceSessionState(state: SessionState, msg: SwToPanel): SessionState {
  if (msg.type !== 'session-state') return state;
  return msg.state;
}

const [sessionState, setSessionState] = createSignal<SessionState>('idle');
const [error, setError] = createSignal<string | null>(null);

export { error, sessionState };

let wired = false;

/** Open the SW port, fold incoming `session-state` pushes into `sessionState`, and pull the
 *  current value once up front — mirrors stores/readiness.ts. Idempotent — safe to call on every
 *  mount. Without the hydrate, a panel re-opened mid-turn started at `idle` (module state died
 *  with the last panel), so App rendered the pre-Start hint and its only button — Start — aborted
 *  the turn that was still running (#165 S5). */
export function initSessionStore(): void {
  if (wired) return;
  wired = true;
  connectPort();
  subscribeToSw((msg) => {
    setSessionState((prev) => reduceSessionState(prev, msg));
  });
  void hydrateSession();
  // The SW's lifecycle is re-read on every reconnect: it persists `state` but `turnRunning` is
  // live-worker-only, so a worker that died mid-turn answers `false` and the panel closes the
  // orphaned bubble instead of spinning on a turn nothing will ever finish.
  onReconnect(() => void hydrateSession());
}

/** Pull the CURRENT session lifecycle + turn liveness from the SW (mount / reconnect / re-check).
 *  The reply is the same fact as the `session-state` push the SW sends on connect, so it is
 *  replayed onto the stream: the chat store closes an orphaned in-flight bubble on
 *  `turnRunning: false` through its own fold, with no store-to-store reach-in. */
export async function hydrateSession(): Promise<void> {
  try {
    const r = await request({ type: 'session-get' }, SessionStateResult);
    publishLocal({ type: 'session-state', state: r.state, turnRunning: r.turnRunning });
  } catch (e) {
    setError(errMsg(e));
  }
}

/** Start the session (only meaningful once `ReadinessState.ready` — the caller gates
 *  the button). A stale in-flight turn is aborted SW-side before the new one primes.
 *
 *  Page access is asked for FIRST, and it has to happen here rather than in the service worker:
 *  `chrome.permissions.request` only prompts inside the user gesture's own call stack, and Start
 *  is a real click. Without it the agent's very first `screenshot` fails with Chrome's
 *  "Either the '<all_urls>' or 'activeTab' permission is required." mid-turn — `activeTab` covers
 *  only the tab that was active when the toolbar icon was clicked, and dies on the next
 *  navigation. Asking once, up front, is the difference between a working vision loop and one
 *  that silently degrades as soon as the user browses.
 *
 *  Fire-and-forget, and never awaited. A denial must not block Start — DOM reads and edits need no
 *  page access, so the session opens either way and the readiness panel's "Page access" row keeps
 *  offering the grant. Awaiting it would also hang Start outright wherever the prompt never
 *  resolves (a headless harness leaves `permissions.request` pending forever — see the note in
 *  test/e2e/settings.spec.ts), which is exactly the kind of dependency Start should not have. */
export async function startSession(): Promise<void> {
  setError(null);
  // First statement, and unawaited: `chrome.permissions.request` only prompts inside the gesture's
  // own call stack, so anything awaited before it kills the prompt (see requestPageAccess).
  void requestPageAccess().catch(() => {});
  try {
    await request({ type: 'session-start' }, OkResult);
  } catch (e) {
    setError(errMsg(e));
  }
}

/** Abort the in-flight agent turn without ending the session — the panel stays on
 *  chat, ready for the next message. */
export async function stopSession(): Promise<void> {
  setError(null);
  try {
    await request({ type: 'session-stop' }, OkResult);
  } catch (e) {
    setError(errMsg(e));
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
