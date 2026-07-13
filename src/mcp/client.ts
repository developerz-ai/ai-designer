// One MCP backend connection, opened lazily and torn down on idle/turn-end. Wraps the
// AI SDK MCP client (Streamable HTTP transport) and namespaces the server's tools
// `<serverId>__<tool>` so several backends can be merged into one agent ToolSet without
// collisions (docs/idea/mcp.md "Namespacing"). SW-ONLY — the transport carries auth
// headers/tokens, which never touch the page world (CLAUDE.md "MV3 three worlds"). Never
// import this from content.ts.

import { createMCPClient, type MCPClientConfig } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';

// Close a connection after this long with no `tools()` call. The service worker is
// ephemeral anyway; this just releases sockets between turns. `<= 0` disables idle close
// (the manager drives an explicit `close()` at turn-end instead).
const DEFAULT_IDLE_MS = 60_000;

// `<serverId>__<tool>`. Mirrors ai-dev's convention for third-party servers.
const NAMESPACE_SEP = '__';

/** Resolves the auth headers for a connection at open time. A function (not a static
 *  record) so an OAuth token can be refreshed per open without re-registering the server;
 *  the API-key path just returns a fixed `Authorization: Bearer` header. Implemented by the
 *  auth layer (slice 02, `src/mcp/auth.ts`). */
export type HeaderResolver = () =>
  | Record<string, string>
  | undefined
  | Promise<Record<string, string> | undefined>;

/** What `createConnection` needs to reach a server. `id` is the stable, unique server id
 *  used for tool namespacing; auth is either a static `headers` record or a lazy
 *  `getHeaders` resolver (`getHeaders` wins when both are set). */
export type McpConnectionSpec = {
  id: string;
  url: string;
  headers?: Record<string, string>;
  getHeaders?: HeaderResolver;
};

// The slice of the AI SDK MCP client this module uses. Structural (not `Pick<MCPClient>`)
// so a test fake needs only these two methods and `tools()` can return a plain ToolSet;
// the real `MCPClient` satisfies it because `client.tools()` yields a namespaceable ToolSet.
export type McpClient = {
  tools(): Promise<ToolSet>;
  close(): Promise<void>;
};

/** Opens an MCP client for a config — the real `createMCPClient` in production, a fake in
 *  tests. Injected via `createConnection`'s options. */
export type McpClientFactory = (config: MCPClientConfig) => Promise<McpClient>;

export type CreateConnectionOptions = {
  /** MCP client factory; defaults to the real `createMCPClient`. */
  connect?: McpClientFactory;
  /** Idle auto-close window in ms; `<= 0` disables it. */
  idleMs?: number;
};

/** A live, lazily-opened handle to one MCP backend. */
export type McpConnection = {
  readonly id: string;
  /** Namespaced tools from the server, opening the client on first use. Cached for the
   *  lifetime of the open client; re-derived after a close (idle or explicit). */
  tools(): Promise<ToolSet>;
  /** Whether the underlying client is currently open. */
  isOpen(): boolean;
  /** Tear down the client (turn-end/idle). Safe to call when already closed. */
  close(): Promise<void>;
};

/** Namespace a single tool name for `serverId`. The id segment is sanitized to
 *  `[A-Za-z0-9_-]` so the result is a valid tool name for strict providers. */
export function namespaceTool(serverId: string, tool: string): string {
  return `${serverId.replace(/[^a-zA-Z0-9_-]/g, '_')}${NAMESPACE_SEP}${tool}`;
}

/** Re-key a server's ToolSet under the `<serverId>__<tool>` namespace. */
function namespaceTools(serverId: string, tools: ToolSet): ToolSet {
  const namespaced: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    namespaced[namespaceTool(serverId, name)] = tool;
  }
  return namespaced;
}

async function resolveHeaders(
  spec: McpConnectionSpec,
): Promise<Record<string, string> | undefined> {
  if (spec.getHeaders) return (await spec.getHeaders()) ?? undefined;
  return spec.headers;
}

/**
 * Build a connection to one MCP backend. Nothing opens until the first `tools()` call
 * (lazy). The open client + its namespaced ToolSet are memoized until `close()` — repeated
 * `tools()` calls within a turn cost no extra round-trips — and re-derived on the next call
 * after an idle/explicit close.
 */
export function createConnection(
  spec: McpConnectionSpec,
  options: CreateConnectionOptions = {},
): McpConnection {
  if (!spec.id) throw new Error('McpConnection: server id is required');
  if (!spec.url) throw new Error(`McpConnection "${spec.id}": url is required`);

  const connect: McpClientFactory = options.connect ?? createMCPClient;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;

  // Both promises are tied to the same open client and cleared together on close. Storing
  // the promise (not the resolved value) dedupes concurrent opens; a rejected open clears
  // itself so the next call retries rather than caching the failure.
  let clientPromise: Promise<McpClient> | null = null;
  let toolsPromise: Promise<ToolSet> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function clearIdle(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdleClose(): void {
    if (idleMs <= 0) return;
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void close();
    }, idleMs);
  }

  // Open (or reuse) the client, resolving auth headers at open time so a refreshed OAuth
  // token is applied per (re)open. A failed open clears itself so the next call retries.
  function openClient(): Promise<McpClient> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const headers = await resolveHeaders(spec);
        return connect({ transport: { type: 'http', url: spec.url, headers } });
      })().catch((err) => {
        clientPromise = null;
        throw err;
      });
    }
    return clientPromise;
  }

  async function tools(): Promise<ToolSet> {
    if (!toolsPromise) {
      toolsPromise = openClient()
        .then(async (client) => namespaceTools(spec.id, await client.tools()))
        .catch((err) => {
          toolsPromise = null; // discovery failed — retry on next call
          throw err;
        });
    }
    const result = await toolsPromise;
    scheduleIdleClose();
    return result;
  }

  async function close(): Promise<void> {
    clearIdle();
    const pending = clientPromise;
    clientPromise = null;
    toolsPromise = null;
    if (!pending) return;
    try {
      await (await pending).close();
    } catch {
      // Already gone / transport error on teardown — nothing to recover.
    }
  }

  return {
    id: spec.id,
    tools,
    isOpen: () => clientPromise !== null,
    close,
  };
}
