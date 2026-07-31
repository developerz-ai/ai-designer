import { createSignal } from 'solid-js';
import { requestPageAccess } from '@/shared/host-permissions';
import type { ReadinessState, SwToPanel } from '@/shared/messages';
import { ReadinessResult } from '@/shared/messages';
import { request } from './bus';
import { connectPort, onReconnect, subscribeToSw } from './sw-stream';

// Readiness store: thin reflection of the SW's `computeReadiness` (src/agent/readiness.ts).
// The SW pushes an unsolicited `readiness` message on every provider/model/host-permission/
// MCP-health change (see background.ts's `pushReadiness`), so this store never re-derives
// readiness itself or polls — it folds that stream, plus one `readiness` RPC on mount to
// cover the window before the first push. CLAUDE.md "SolidJS + SRP": header pill reads
// this store, dispatches nothing back.

/** Pure fold: apply one SW->panel message onto the readiness state. Unrelated message
 *  types are a no-op (identity). Exported for a mock-free unit test, mirroring
 *  stores/focus.ts's `reduceFocus`. */
export function reduceReadiness(
  state: ReadinessState | null,
  msg: SwToPanel,
): ReadinessState | null {
  if (msg.type !== 'readiness') return state;
  return msg.state;
}

const [state, setState] = createSignal<ReadinessState | null>(null);
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

export { error, loading, state };

let wired = false;

/** Open the SW port, fold incoming `readiness` pushes into `state`, and pull the current
 *  value once up front (RPC) so the pill has data before the first push arrives.
 *  Idempotent — safe to call on every mount. */
export function initReadinessStore(): void {
  if (wired) return;
  wired = true;
  connectPort();
  subscribeToSw((msg) => {
    setState((prev) => reduceReadiness(prev, msg));
  });
  void hydrateReadiness();
  // A dropped Port means the SW may have restarted, and readiness counts live MCP health — which
  // resets to `disconnected` with the worker. Re-pull rather than keep rendering the old worker's
  // "1/1 connected" (#165 S5).
  onReconnect(() => void hydrateReadiness());
}

/** Pull the current readiness snapshot from the SW (mount / manual refresh). Never throws
 *  on the RPC's own compute — `computeReadiness` swallows its errors — only a transport
 *  failure (e.g. SW asleep mid-restart) lands here. */
export async function hydrateReadiness(): Promise<void> {
  setLoading(true);
  setError(null);
  try {
    const r = await request({ type: 'readiness' }, ReadinessResult);
    setState(r.state);
  } catch (e) {
    setError(errMsg(e));
  } finally {
    setLoading(false);
  }
}

/** Grant broad page access, then re-pull readiness so the row flips without a reload.
 *
 *  Called straight from the dropdown's Grant click: `chrome.permissions.request` only prompts
 *  inside a live user gesture in the SAME call stack, so this cannot be an RPC to the service
 *  worker (see src/shared/host-permissions.ts) — the panel has to ask for it itself, exactly like
 *  `saveProvider` does for a custom provider origin. */
export async function grantPageAccess(): Promise<void> {
  setError(null);
  const result = await requestPageAccess();
  if (!result.ok) {
    setError(result.error ?? 'Page access denied.');
    return;
  }
  await hydrateReadiness();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
