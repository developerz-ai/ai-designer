// Per-tool opt-in grants for backend write-shaped tools (#120). The #117 gate strips the Ship
// dispatch verb (`task`) by name — but any OTHER side-effecting tool a user-connected third-party
// MCP server exposes (`deploy`, `create_pr`, `send_email`, …) would otherwise reach the design
// loop ungated. This store persists the user's per-server, per-tool opt-ins: a write-shaped tool
// is offered to a design turn ONLY when its base name is granted here. `task` can NEVER be
// granted — its only sanctioned dispatch path stays the user-clicked Ship RPC.
//
// The heuristic (name-based, like #117's — MCP `readOnlyHint` annotations are untrusted hints the
// spec forbids relying on for security decisions) lives in `design-gate.ts`; this module is the
// durable half. Read tools never match the verb set, so #21's consult-the-backend value keeps
// zero friction.
//
// SW-ONLY: never import this from content.ts. See docs/architecture/security.md.

// One `storage.local` key holds the whole map (small, always read/written together): serverId →
// granted tool BASE names (the post-namespace name, e.g. `deploy` — never the namespaced
// `<id>__deploy`).
const TOOL_GRANTS_KEY = 'mcp:tool-grants';

/** The persisted grant map: server id → granted base names. */
export type ToolGrants = Record<string, readonly string[]>;

/** Every persisted grant. Corrupt entries are dropped on read rather than failing the whole
 *  map — same defensive posture as `listServers`. */
export async function getToolGrants(): Promise<ToolGrants> {
  const got = await chrome.storage.local.get(TOOL_GRANTS_KEY);
  const raw = got[TOOL_GRANTS_KEY];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const grants: ToolGrants = {};
  for (const [serverId, tools] of Object.entries(raw as Record<string, unknown>)) {
    if (!serverId || !Array.isArray(tools)) continue;
    const names = tools.filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (names.length > 0) grants[serverId] = names;
  }
  return grants;
}

/** Grant or revoke one tool for one server (idempotent). Revoking the last grant drops the
 *  server's key entirely so the map stays minimal. */
export async function setToolGrant(
  serverId: string,
  tool: string,
  granted: boolean,
): Promise<void> {
  const grants = await getToolGrants();
  const current = new Set(grants[serverId] ?? []);
  if (granted) current.add(tool);
  else current.delete(tool);
  const next = { ...grants };
  if (current.size === 0) delete next[serverId];
  else next[serverId] = [...current];
  await chrome.storage.local.set({ [TOOL_GRANTS_KEY]: next });
}

/** Forget every grant a server holds — called on server removal so no orphaned grant survives
 *  (mirrors removeServer's credential purge). No-op when the server has none. */
export async function clearToolGrants(serverId: string): Promise<void> {
  const grants = await getToolGrants();
  if (!(serverId in grants)) return;
  const next = { ...grants };
  delete next[serverId];
  await chrome.storage.local.set({ [TOOL_GRANTS_KEY]: next });
}
