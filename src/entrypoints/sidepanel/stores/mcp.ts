import { createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type {
  AuthKind,
  McpOAuthConfig,
  McpServer,
  McpTransport,
  SwToPanel,
} from '@/shared/messages';
import { McpListResult, McpServerResult, OkResult } from '@/shared/messages';
import { request } from './bus';
import { connectPort, subscribeToSw } from './sw-stream';

// MCP store: thin reflection of the SW's server registry (src/mcp/store.ts) + live
// connection health (src/mcp/manager.ts). Every mutation — add/remove/connect/auth —
// is an RPC to the service worker; this module never talks to chrome.identity or the
// key-store itself, it only dispatches and folds the `mcp-status` stream + RPC replies
// into local state (CLAUDE.md "SolidJS + SRP" — McpPanel/AuthDialog stay render +
// dispatch only).

/** Pure fold: apply one SW->panel message onto the server list. Unrelated message
 *  types are a no-op (identity). Exported for a mock-free unit test, mirroring
 *  stores/focus.ts's `reduceFocus`. */
export function reduceServers(servers: McpServer[], msg: SwToPanel): McpServer[] {
  if (msg.type !== 'mcp-status') return servers;
  const idx = servers.findIndex((s) => s.id === msg.server.id);
  if (idx === -1) return [...servers, msg.server];
  const next = servers.slice();
  next[idx] = msg.server;
  return next;
}

const [servers, setServers] = createStore<McpServer[]>([]);
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
// Per-server AuthDialog flight state, keyed by server id so more than one dialog
// instance (unlikely, but cheap to support) never cross-talks.
const [authPending, setAuthPending] = createSignal<string | null>(null);
const [authError, setAuthError] = createSignal<string | null>(null);

export { authError, authPending, error, loading, servers };

let wired = false;

/** Open the SW port and fold incoming `mcp-status` pushes into `servers`. Idempotent —
 *  safe to call on every McpPanel mount. */
export function initMcpStore(): void {
  if (wired) return;
  wired = true;
  connectPort();
  subscribeToSw((msg) => {
    if (msg.type !== 'mcp-status') return;
    // reconcile (keyed by `id`) so only the changed server's fields re-render — a plain array
    // replace hands every row a wire-fresh object, remounting keyed `<For>` rows in McpPanel.
    setServers(reconcile(reduceServers(servers, msg), { key: 'id' }));
  });
}

/** Pull the full registered-server list from the SW (mount / manual refresh). */
export async function hydrateMcp(): Promise<void> {
  setLoading(true);
  setError(null);
  try {
    const r = await request({ type: 'mcp-list' }, McpListResult);
    if (r.ok) setServers(r.servers ?? []);
    else setError(r.error ?? 'Failed to list MCP servers.');
  } catch (e) {
    setError(errMsg(e));
  } finally {
    setLoading(false);
  }
}

/** Register a new backend (optionally from a `DEFAULT_BACKENDS` preset). Registers with
 *  `authKind: 'none'` unless given — auth is set later via `submitApiKey`/`startOAuth`,
 *  which also flips the stored `authKind` to match (see background.ts `mcp-auth-start`). */
export async function addServer(input: {
  label: string;
  url: string;
  transport?: McpTransport;
  authKind?: AuthKind;
}): Promise<boolean> {
  setError(null);
  try {
    const r = await request({ type: 'mcp-add', ...input }, McpServerResult);
    if (!r.ok) {
      setError(r.error ?? 'Failed to add server.');
      return false;
    }
    if (r.server) upsertLocal(r.server);
    return true;
  } catch (e) {
    setError(errMsg(e));
    return false;
  }
}

/** Forget a server + purge its credentials (SW-side). */
export async function removeServer(id: string): Promise<void> {
  setError(null);
  try {
    const r = await request({ type: 'mcp-remove', id }, OkResult);
    if (!r.ok) {
      setError(r.error ?? 'Failed to remove server.');
      return;
    }
    setServers((list) => list.filter((s) => s.id !== id));
  } catch (e) {
    setError(errMsg(e));
  }
}

/** (Re)open a server's connection and refresh its health/tool catalog. Never throws on a
 *  reachability failure — the resulting `status:'error'` is reflected on the record. */
export async function connectServer(id: string): Promise<void> {
  setError(null);
  try {
    const r = await request({ type: 'mcp-connect', id }, McpServerResult);
    if (r.server) upsertLocal(r.server);
    else if (!r.ok) setError(r.error ?? `Failed to connect ${id}.`);
  } catch (e) {
    setError(errMsg(e));
  }
}

/** AuthDialog's API-key path: store the key, then reconnect with the new Bearer header. */
export async function submitApiKey(id: string, apiKey: string): Promise<boolean> {
  return runAuth(id, { type: 'mcp-auth-start', id, authKind: 'apikey', apiKey });
}

/** AuthDialog's OAuth path: run the PKCE flow (opens `chrome.identity.launchWebAuthFlow`
 *  in the SW), then reconnect with the issued token. */
export async function startOAuth(id: string, oauth: McpOAuthConfig): Promise<boolean> {
  return runAuth(id, { type: 'mcp-auth-start', id, authKind: 'oauth', oauth });
}

async function runAuth(
  id: string,
  msg:
    | { type: 'mcp-auth-start'; id: string; authKind: 'apikey'; apiKey: string }
    | { type: 'mcp-auth-start'; id: string; authKind: 'oauth'; oauth: McpOAuthConfig },
): Promise<boolean> {
  setAuthPending(id);
  setAuthError(null);
  try {
    const r = await request(msg, McpServerResult);
    if (!r.ok) {
      setAuthError(r.error ?? 'Authorization failed.');
      return false;
    }
    if (r.server) upsertLocal(r.server);
    return true;
  } catch (e) {
    setAuthError(errMsg(e));
    return false;
  } finally {
    setAuthPending(null);
  }
}

function upsertLocal(server: McpServer): void {
  setServers(reconcile(reduceServers(servers, { type: 'mcp-status', server }), { key: 'id' }));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
