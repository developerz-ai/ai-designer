// Persistence for the user's MCP server list. The non-secret record
// `{id,label,url,transport,authKind}` lives plaintext in `chrome.storage.local` under
// `mcp:servers`; each server's credentials (API key / OAuth token) live in the encrypted
// key-store keyed by the same id (see ./auth). Removing a server purges its secrets so no
// orphaned token survives. This mirrors config-store's plaintext/secret split.
//
// The schemas here are the persisted vocabulary; the bus `McpServer`/`AuthKind` message
// shapes (next slice) build on them so the wire and stored shapes can't drift.
//
// SW-ONLY: never import this from content.ts. See docs/architecture/security.md.

import { z } from 'zod';
import { clearAuth } from './auth';
import type { OriginRepoMap } from './handoff';

// One `storage.local` key holds the whole list (small, always read/written together).
const SERVERS_KEY = 'mcp:servers';
// The origin→repo map for one-click Ship (docs/idea/mcp.md "Connecting"); one small record.
const ORIGIN_REPO_KEY = 'mcp:origin-repo';

/** Transport to the backend. Only HTTP-streamable today (docs/idea/mcp.md); the enum leaves
 *  room for more (e.g. SSE) without a schema migration. */
export const McpTransport = z.enum(['http']);
export type McpTransport = z.infer<typeof McpTransport>;

/** How the extension authenticates to a backend (docs/idea/mcp.md "Auth"): `apikey` ->
 *  `Authorization: Bearer <key>`; `oauth` -> PKCE user token; `none` -> open server. */
export const AuthKind = z.enum(['none', 'apikey', 'oauth']);
export type AuthKind = z.infer<typeof AuthKind>;

/** The non-secret record persisted per server. `transport`/`authKind` default so a minimal
 *  `{id,label,url}` from the Add-server form is accepted; the credential itself never lives
 *  here — it's in the key-store (see ./auth). */
export const StoredServer = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  url: z.string().url(),
  transport: McpTransport.default('http'),
  authKind: AuthKind.default('none'),
});
export type StoredServer = z.infer<typeof StoredServer>;
/** Pre-default input: `transport`/`authKind` optional (the Add-server form supplies `{id,
 *  label,url}`). `saveServer` normalizes to a full `StoredServer`. */
export type StoredServerInput = z.input<typeof StoredServer>;

/** Every persisted server, newest write last. Corrupt entries are dropped on read rather
 *  than failing the whole list. */
export async function listServers(): Promise<StoredServer[]> {
  const got = await chrome.storage.local.get(SERVERS_KEY);
  const raw = got[SERVERS_KEY];
  if (!Array.isArray(raw)) return [];
  const servers: StoredServer[] = [];
  for (const item of raw) {
    const parsed = StoredServer.safeParse(item);
    if (parsed.success) servers.push(parsed.data);
  }
  return servers;
}

/** One persisted server by id, or null if unknown. */
export async function getServer(id: string): Promise<StoredServer | null> {
  return (await listServers()).find((s) => s.id === id) ?? null;
}

/** Persist a server, replacing any existing record with the same id (upsert). Returns the
 *  normalized record (defaults applied). Throws on an invalid shape/url. */
export async function saveServer(server: StoredServerInput): Promise<StoredServer> {
  const parsed = StoredServer.parse(server);
  const next = (await listServers()).filter((s) => s.id !== parsed.id);
  next.push(parsed);
  await chrome.storage.local.set({ [SERVERS_KEY]: next });
  return parsed;
}

/** Forget a server and purge its stored credentials. No-op record write when the id is
 *  unknown, but its secrets are cleared regardless (defensive). */
export async function removeServer(id: string): Promise<void> {
  const list = await listServers();
  const next = list.filter((s) => s.id !== id);
  if (next.length !== list.length) {
    await chrome.storage.local.set({ [SERVERS_KEY]: next });
  }
  await clearAuth(id);
}

/** The persisted origin→repo map that backs one-click Ship (`src/mcp/handoff.ts` `resolveRepo`).
 *  Non-string / empty entries are dropped on read so a corrupt write can't break repo resolution —
 *  same defensive posture as `listServers`. */
export async function getOriginRepoMap(): Promise<OriginRepoMap> {
  const got = await chrome.storage.local.get(ORIGIN_REPO_KEY);
  const raw = got[ORIGIN_REPO_KEY];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map: OriginRepoMap = {};
  for (const [origin, repo] of Object.entries(raw as Record<string, unknown>)) {
    if (origin && typeof repo === 'string' && repo) map[origin] = repo;
  }
  return map;
}

/** Map a page origin (`host[:port]`) to a repo slug (`owner/name`), replacing any prior mapping. */
export async function setOriginRepo(origin: string, repo: string): Promise<void> {
  const map = await getOriginRepoMap();
  map[origin] = repo;
  await chrome.storage.local.set({ [ORIGIN_REPO_KEY]: map });
}

/** Forget a page origin's repo mapping. No-op when the origin isn't mapped. */
export async function clearOriginRepo(origin: string): Promise<void> {
  const map = await getOriginRepoMap();
  if (!(origin in map)) return;
  delete map[origin];
  await chrome.storage.local.set({ [ORIGIN_REPO_KEY]: map });
}
