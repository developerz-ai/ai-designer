import { createSignal } from 'solid-js';
import type { SwToPanel } from '@/shared/messages';
import { OkResult } from '@/shared/messages';
import { request } from './bus';
import { connectPort, subscribeToSw } from './sw-stream';

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

/** Open the SW port and fold incoming `session-state` pushes into `sessionState`.
 *  Idempotent — safe to call on every mount. */
export function initSessionStore(): void {
  if (wired) return;
  wired = true;
  connectPort();
  subscribeToSw((msg) => {
    setSessionState((prev) => reduceSessionState(prev, msg));
  });
}

/** Start the session (only meaningful once `ReadinessState.ready` — the caller gates
 *  the button). A stale in-flight turn is aborted SW-side before the new one primes. */
export async function startSession(): Promise<void> {
  setError(null);
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
