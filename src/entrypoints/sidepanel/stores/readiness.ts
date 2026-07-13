import { createSignal } from 'solid-js';
import type { ReadinessState, SwToPanel } from '@/shared/messages';
import { ReadinessResult } from '@/shared/messages';
import { request } from './bus';
import { connectPort, subscribeToSw } from './sw-stream';

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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
