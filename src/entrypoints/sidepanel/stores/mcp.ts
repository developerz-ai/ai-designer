import { createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { i18n } from '#i18n';
import type {
  AuthKind,
  McpOAuthConfig,
  McpServer,
  McpTransport,
  OriginRepoEntry,
  SwToPanel,
} from '@/shared/messages';
import { McpListResult, McpOriginRepoResult, McpServerResult, OkResult } from '@/shared/messages';
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

/** Pure fold: apply a saved origin→repo entry onto the map (add-or-replace). Exported for a
 *  mock-free unit test, mirroring `reduceServers`. */
export function upsertOriginRepo(
  map: Record<string, OriginRepoEntry>,
  origin: string,
  entry: OriginRepoEntry,
): Record<string, OriginRepoEntry> {
  return { ...map, [origin]: entry };
}

/** Pure fold: drop one origin's entry (a missing key is an identity no-op). */
export function dropOriginRepo(
  map: Record<string, OriginRepoEntry>,
  origin: string,
): Record<string, OriginRepoEntry> {
  if (!(origin in map)) return map;
  const next = { ...map };
  delete next[origin];
  return next;
}

/** The origin→repo map key for a page URL, panel-side (#20): lowercased `host[:port]`, http(s)
 *  only — the panel's OWN extension origin (or about:blank / chrome://) is never a design target,
 *  so it yields null and the mapping form stays inert. Mirrors src/mcp/handoff.ts `originOf`. */
export function pageOriginOf(url: string | undefined): string | null {
  if (!url || !/^https?:/i.test(url)) return null;
  try {
    return new URL(url).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The bus carries only the RENDERED fallback sentence (src/mcp/backend.ts `fallbackMessage`),
 *  not the 'no-repo' enum — so ShipBar's map-now affordance keys off the message text. */
export function isNoRepoReason(reason: string | null): boolean {
  return reason !== null && /no repo is mapped/i.test(reason);
}

const [servers, setServers] = createStore<McpServer[]>([]);
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
// Per-server AuthDialog flight state, keyed by server id so more than one dialog
// instance (unlikely, but cheap to support) never cross-talks.
const [authPending, setAuthPending] = createSignal<string | null>(null);
const [authError, setAuthError] = createSignal<string | null>(null);
// The origin→repo routing map (#20) — the whole map, mirrored from the SW (mcp-origin-repo-get;
// set/clear fold their own mutation in on ok, and reload on failure). Small and user-curated, so
// a wholesale signal replace beats per-key reconciliation.
const [originRepos, setOriginRepos] = createSignal<Record<string, OriginRepoEntry>>({});
// The origin the mapping form edits: the active tab of the last-focused window (the SAME signal
// the SW ships against — background.ts `resolveTargetTab`), so a mapping saved here is the one the
// next Ship reads. null on a non-http(s) tab (extension pages, chrome://, about:blank).
const [activeOrigin, setActiveOrigin] = createSignal<string | null>(null);

export { activeOrigin, authError, authPending, error, loading, originRepos, servers };

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
  // activeOrigin follows tab switches + active-tab navigations so the origin→repo form always
  // edits the page the user is looking at (all guarded — the unit-test chrome fake carries only
  // `runtime`; mirrors stores/changeset.ts's own guarded tab listeners).
  void refreshActiveOrigin();
  chrome.tabs?.onActivated?.addListener?.(() => void refreshActiveOrigin());
  chrome.tabs?.onUpdated?.addListener?.((_tabId, changeInfo, tab) => {
    if (tab?.active && changeInfo.url) setActiveOrigin(pageOriginOf(changeInfo.url));
  });
}

/** Re-derive `activeOrigin` from the active tab of the last-focused window. Best-effort: a
 *  query failure (no window, restricted tab) leaves the prior value. */
export async function refreshActiveOrigin(): Promise<void> {
  const query = chrome.tabs?.query?.bind(chrome.tabs);
  if (!query) return;
  try {
    const [tab] = await query({ active: true, lastFocusedWindow: true });
    setActiveOrigin(pageOriginOf(tab?.url));
  } catch {
    // Leave the previous origin — a transient query failure must not blank a filled form.
  }
}

/** Pull the full registered-server list from the SW (mount / manual refresh). */
export async function hydrateMcp(): Promise<void> {
  setLoading(true);
  setError(null);
  try {
    const r = await request({ type: 'mcp-list' }, McpListResult);
    if (r.ok) setServers(r.servers ?? []);
    else setError(r.error ?? i18n.t('mcp.error.listFailed'));
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
      setError(r.error ?? i18n.t('mcp.error.addFailed'));
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
      setError(r.error ?? i18n.t('mcp.error.removeFailed'));
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
    else if (!r.ok) setError(r.error ?? i18n.t('mcp.error.connectFailed', { id }));
  } catch (e) {
    setError(errMsg(e));
  }
}

/** Flip a server's per-backend enabled flag (#17). The SW persists it and flips the manager
 *  registration (disabling tears the live connection down); the replied record folds back into
 *  the row. A disabled server never connects and Ship skips it. */
export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  setError(null);
  try {
    const r = await request({ type: 'mcp-set-enabled', id, enabled }, McpServerResult);
    if (r.server) upsertLocal(r.server);
    else if (!r.ok) setError(r.error ?? i18n.t('mcp.error.saveFailed'));
  } catch (e) {
    setError(errMsg(e));
  }
}

// --- origin → repo map (#20) ----------------------------------------------------------------
// The one-click-Ship routing map the OriginRepoSection curates. Get returns the whole map;
// set/clear reply a bare ok, so the local fold applies the same mutation the SW persisted —
// and a failure reloads from the SW rather than trusting a stale local copy.

/** Pull the whole origin→repo map from the SW (mount / after a failed mutation). */
export async function loadOriginRepos(): Promise<void> {
  try {
    const r = await request({ type: 'mcp-origin-repo-get' }, McpOriginRepoResult);
    if (r.ok) setOriginRepos(r.map ?? {});
    else setError(r.error ?? i18n.t('mcp.originRepo.error.loadFailed'));
  } catch (e) {
    setError(errMsg(e));
  }
}

/** Save (add-or-replace) one origin's routing entry. Returns true when the SW persisted it —
 *  ShipBar's map-now affordance re-fires Ship only on true. */
export async function saveOriginRepo(origin: string, entry: OriginRepoEntry): Promise<boolean> {
  setError(null);
  try {
    const r = await request({ type: 'mcp-origin-repo-set', origin, entry }, OkResult);
    if (!r.ok) {
      setError(r.error ?? i18n.t('mcp.originRepo.error.saveFailed'));
      await loadOriginRepos();
      return false;
    }
    setOriginRepos((map) => upsertOriginRepo(map, origin, entry));
    return true;
  } catch (e) {
    setError(errMsg(e));
    await loadOriginRepos().catch(() => {});
    return false;
  }
}

/** Drop one origin's routing entry (Ship then falls back to a downloadable brief for it). */
export async function removeOriginRepo(origin: string): Promise<void> {
  setError(null);
  try {
    const r = await request({ type: 'mcp-origin-repo-clear', origin }, OkResult);
    if (!r.ok) {
      setError(r.error ?? i18n.t('mcp.originRepo.error.removeFailed'));
      await loadOriginRepos();
      return;
    }
    setOriginRepos((map) => dropOriginRepo(map, origin));
  } catch (e) {
    setError(errMsg(e));
    await loadOriginRepos().catch(() => {});
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
      setAuthError(r.error ?? i18n.t('mcp.error.authFailed'));
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
