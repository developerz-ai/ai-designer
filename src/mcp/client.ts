// One MCP backend connection, opened lazily and torn down explicitly. Wraps the AI SDK MCP
// client (Streamable HTTP transport) and namespaces the server's tools `<serverId>__<tool>` so
// several backends can be merged into one agent ToolSet without collisions (docs/idea/mcp.md
// "Namespacing"). SW-ONLY — the transport carries auth headers/tokens, which never touch the page
// world (CLAUDE.md "MV3 three worlds"). Never import this from content.ts.
//
// LIFECYCLE CONTRACT (#165 S2). There is deliberately NO idle timer. Teardown happens on an
// explicit `close()` — a server disabled/removed/re-registered (`src/mcp/manager.ts`) — or when
// Chrome terminates the service worker, which reclaims every socket for free. An idle close was
// tried and removed: in MV3 it could only ever fire while the worker was ALIVE, and the worker only
// stays alive while something is happening (a design turn holding tool closures, a Ship `task
// watch` long-poll). It therefore never released a socket that ephemerality wasn't about to
// release anyway, and did fire in the one case that must not be interrupted — closing the transport
// under the model's live tool closures ("client closed" the model reads as an unrecoverable backend
// failure) and under Ship's `watch`, which always outlives a minute and whose loss surfaces to the
// user as a task "error" while the task runs fine.
//
// Two DEADLINES remain, where a hang would otherwise be unrecoverable: `connect` (the open + first
// discovery, which the worker would otherwise sit on until eviction) and `close` (a wedged teardown
// must never block an unregister). Everything else is bounded by the caller's own signal.
//
// LEASES make "closed under an in-flight call" structurally impossible rather than merely unlikely:
// `tools()` and every tool `execute` hold a lease for their duration, and a `close()` arriving while
// leases are outstanding is DEFERRED — the last release performs it.

import { createMCPClient, type MCPClientConfig } from '@ai-sdk/mcp';
import type { Tool, ToolSet } from 'ai';

// Bound the open + first tool discovery. A backend that never answers would otherwise hold the
// caller (a turn's `toolsFor()`, a panel `mcp-connect` RPC) until the worker is evicted; this
// degrades it to a normal `status: 'error'` the panel renders.
const CONNECT_TIMEOUT_MS = 30_000;
// Bound teardown. A wedged transport must not block `unregister`/`setEnabled(false)` — we drop the
// handle and let the worker's death reclaim whatever the transport still holds.
const CLOSE_TIMEOUT_MS = 5_000;

// `<serverId>__<tool>`. Mirrors ai-dev's convention for third-party servers. Exported for the
// design-turn write-tool gate (design-gate.ts), which suffix-matches on it.
export const NAMESPACE_SEP = '__';

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
  /** Open + first-discovery deadline in ms (default {@link CONNECT_TIMEOUT_MS}); tests shorten it. */
  connectTimeoutMs?: number;
  /** Teardown deadline in ms (default {@link CLOSE_TIMEOUT_MS}); tests shorten it. */
  closeTimeoutMs?: number;
};

/** A live, lazily-opened handle to one MCP backend. */
export type McpConnection = {
  readonly id: string;
  /** Namespaced tools from the server, opening the client on first use. Cached for the
   *  lifetime of the open client; re-derived after a close. Each returned tool's `execute`
   *  holds a lease for its duration, so a concurrent `close()` waits it out. */
  tools(): Promise<ToolSet>;
  /** Whether the underlying client is currently open. */
  isOpen(): boolean;
  /** Tear down the client (server disabled/removed/re-registered). Safe to call when already
   *  closed. DEFERRED while any `tools()`/tool `execute` lease is outstanding — the last release
   *  performs the close, so a teardown can never land under an in-flight call. */
  close(): Promise<void>;
};

/** Namespace a single tool name for `serverId`. The id segment is sanitized to
 *  `[A-Za-z0-9_-]` so the result is a valid tool name for strict providers. */
export function namespaceTool(serverId: string, tool: string): string {
  return `${serverId.replace(/[^a-zA-Z0-9_-]/g, '_')}${NAMESPACE_SEP}${tool}`;
}

/** The connection's in-flight-work counter, handed to each wrapped tool so a call it makes
 *  outlives no `close()` (see the LIFECYCLE CONTRACT above). */
type Lease = { acquire(): void; release(): void };

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

// Hold a lease for the duration of one tool call. The AI SDK's MCP tools call `client.callTool`
// directly, so without this the connection has NO idea a call is in flight (the exact gap that let
// a teardown land mid-call). A tool with no `execute` passes through untouched. A non-thenable
// return (a streaming tool's AsyncIterable — MCP tools don't produce one) releases immediately
// rather than pinning the lease forever.
function leaseExecute(entry: Tool, lease: Lease): Tool {
  const execute = entry.execute;
  if (typeof execute !== 'function') return entry;
  const leased = ((input, options) => {
    lease.acquire();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      lease.release();
    };
    let result: unknown;
    try {
      result = execute(input, options);
    } catch (err) {
      release();
      throw err;
    }
    if (!isPromiseLike(result)) {
      release();
      return result;
    }
    return Promise.resolve(result).then(
      (value) => {
        release();
        return value;
      },
      (err) => {
        release();
        throw err;
      },
    );
  }) as typeof execute;
  return { ...entry, execute: leased };
}

/** Re-key a server's ToolSet under the `<serverId>__<tool>` namespace, leasing each tool's call. */
function namespaceTools(serverId: string, tools: ToolSet, lease: Lease): ToolSet {
  const namespaced: ToolSet = {};
  for (const [name, entry] of Object.entries(tools)) {
    namespaced[namespaceTool(serverId, name)] = leaseExecute(entry, lease);
  }
  return namespaced;
}

async function resolveHeaders(
  spec: McpConnectionSpec,
): Promise<Record<string, string> | undefined> {
  if (spec.getHeaders) return (await spec.getHeaders()) ?? undefined;
  return spec.headers;
}

/** Reject with `message` if `work` hasn't settled within `ms`. The underlying work is NOT
 *  cancelled (neither the MCP client nor `fetch` exposes a handle here) — the caller stops waiting
 *  and the connection drops its reference, so an eventual late settlement is garbage. Both sides of
 *  the race settle by VALUE rather than rejection: a losing promise that rejects later has no
 *  listener left, and Node reports that as an unhandled rejection (a crash in Sentry, a failed test
 *  run) even though it is expected here. */
async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = work.then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  try {
    const outcome = await Promise.race([
      settled,
      new Promise<'deadline'>((resolve) => {
        timer = setTimeout(() => resolve('deadline'), ms);
      }),
    ]);
    if (outcome === 'deadline') throw new Error(message);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a connection to one MCP backend. Nothing opens until the first `tools()` call
 * (lazy). The open client + its namespaced ToolSet are memoized until `close()` — repeated
 * `tools()` calls within a turn cost no extra round-trips — and re-derived on the next call
 * after a close.
 */
export function createConnection(
  spec: McpConnectionSpec,
  options: CreateConnectionOptions = {},
): McpConnection {
  if (!spec.id) throw new Error('McpConnection: server id is required');
  if (!spec.url) throw new Error(`McpConnection "${spec.id}": url is required`);

  const connect: McpClientFactory = options.connect ?? createMCPClient;
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;

  // Both promises are tied to the same open client and cleared together on close. Storing
  // the promise (not the resolved value) dedupes concurrent opens; a rejected open clears
  // itself so the next call retries rather than caching the failure.
  let clientPromise: Promise<McpClient> | null = null;
  let toolsPromise: Promise<ToolSet> | null = null;
  // Outstanding `tools()` / tool-`execute` calls, and whether a `close()` arrived while they ran.
  let leases = 0;
  let closePending = false;

  const lease: Lease = {
    acquire: () => {
      leases++;
    },
    release: () => {
      leases = Math.max(0, leases - 1);
      // The deferred teardown the LIFECYCLE CONTRACT promises: the last call out turns the lights
      // off. Fire-and-forget — the `close()` that deferred already resolved to its caller.
      if (leases === 0 && closePending) void closeNow();
    },
  };

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
    lease.acquire();
    try {
      if (!toolsPromise) {
        // ONE deadline over open + discovery: a transport that connects but never answers
        // `tools()` is as unrecoverable as one that never connects.
        toolsPromise = withDeadline(
          openClient().then(async (client) => namespaceTools(spec.id, await client.tools(), lease)),
          connectTimeoutMs,
          `MCP server "${spec.id}" did not respond within ${Math.round(connectTimeoutMs / 1000)}s`,
        ).catch((err) => {
          toolsPromise = null; // open/discovery failed — retry on next call
          // A deadline leaves a possibly-still-opening client dangling; drop it so the retry
          // opens fresh rather than adopting a transport nobody is waiting on. Through `close()`
          // (not `closeNow`) so it still queues behind any concurrent lease.
          void close();
          throw err;
        });
      }
      return await toolsPromise;
    } finally {
      lease.release();
    }
  }

  // The real teardown. Never call this directly from outside — `close()` owns the lease check.
  async function closeNow(): Promise<void> {
    closePending = false;
    const pending = clientPromise;
    clientPromise = null;
    toolsPromise = null;
    if (!pending) return;
    try {
      await withDeadline(
        (async () => {
          await (await pending).close();
        })(),
        closeTimeoutMs,
        `MCP server "${spec.id}" did not close within ${Math.round(closeTimeoutMs / 1000)}s`,
      );
    } catch {
      // Already gone, transport error, or a wedged teardown past the deadline — the handle is
      // dropped either way and the worker's death reclaims the socket. Nothing to recover.
    }
  }

  async function close(): Promise<void> {
    if (leases > 0) {
      // Defer: a call is in flight (a design turn's backend tool, Ship's `task watch`). The last
      // `lease.release()` runs `closeNow()`.
      closePending = true;
      return;
    }
    await closeNow();
  }

  return {
    id: spec.id,
    tools,
    isOpen: () => clientPromise !== null,
    close,
  };
}
