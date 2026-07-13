// Registry of MCP backends the agent can reach, with a per-server health + tool-catalog
// cache and a `toolsFor()` merge that hands the loop (slice 04) one namespaced ToolSet.
// Owns connection lifecycle: lazy open via `McpConnection`, explicit teardown at turn-end.
// SW-ONLY — holds connections whose transports carry auth tokens; never import from
// content.ts. Wired in `background.ts` (slice 02, step 4).

import type { ToolSet } from 'ai';
import {
  type CreateConnectionOptions,
  createConnection,
  type McpConnection,
  type McpConnectionSpec,
} from './client';

/** Last-known connection state for a registered server. `'disconnected'` = registered but
 *  not yet opened (or torn down); `'connected'` = tools discovered; `'error'` = the last
 *  open/discovery failed (`error` carries why). */
export type McpStatus = 'disconnected' | 'connected' | 'error';

export type McpHealth = {
  id: string;
  status: McpStatus;
  /** Number of tools discovered on the last successful connect (0 otherwise). */
  toolCount: number;
  /** Namespaced tool names from the last successful connect. */
  tools: string[];
  /** Failure reason when `status === 'error'`. */
  error?: string;
  /** `now()` at the last status change. */
  checkedAt: number;
};

export type McpManagerOptions = CreateConnectionOptions & {
  /** Injectable clock for `health.checkedAt` (tests pin it; defaults to `Date.now`). */
  now?: () => number;
};

type Entry = { spec: McpConnectionSpec; connection: McpConnection; health: McpHealth };

/**
 * The service worker's MCP registry. Register the servers the user configured, then call
 * `toolsFor()` at the start of a turn to get every connected backend's tools merged and
 * namespaced. Per-server failures are isolated: one unreachable backend degrades to
 * `status:'error'` and is skipped from the merge rather than breaking the others.
 */
export class McpManager {
  private readonly servers = new Map<string, Entry>();
  private readonly connectionOptions: CreateConnectionOptions;
  private readonly now: () => number;

  constructor(options: McpManagerOptions = {}) {
    const { now, ...connectionOptions } = options;
    this.connectionOptions = connectionOptions;
    this.now = now ?? (() => Date.now());
  }

  /** Register (or replace) a server. Replacing closes the previous connection first.
   *  Nothing connects until `connect()`/`toolsFor()` — registration is cheap. */
  register(spec: McpConnectionSpec): void {
    const existing = this.servers.get(spec.id);
    if (existing) void existing.connection.close();
    this.servers.set(spec.id, {
      spec,
      connection: createConnection(spec, this.connectionOptions),
      health: {
        id: spec.id,
        status: 'disconnected',
        toolCount: 0,
        tools: [],
        checkedAt: this.now(),
      },
    });
  }

  /** Forget a server and tear down its connection. No-op for an unknown id. */
  async unregister(id: string): Promise<void> {
    const entry = this.servers.get(id);
    if (!entry) return;
    this.servers.delete(id);
    await entry.connection.close();
  }

  has(id: string): boolean {
    return this.servers.has(id);
  }

  ids(): string[] {
    return [...this.servers.keys()];
  }

  /** Open + discover a single server, refreshing its cached health. Never throws — a
   *  failure is recorded on the returned health. Unknown id → null. */
  async connect(id: string): Promise<McpHealth | null> {
    const entry = this.servers.get(id);
    if (!entry) return null;
    await this.discover(entry);
    return entry.health;
  }

  /** Merge the namespaced tools of the given servers (all registered, by default) into one
   *  ToolSet for the agent loop. Servers are opened lazily and in parallel; any that fail
   *  are recorded as `error` and omitted from the result. */
  async toolsFor(ids?: string[]): Promise<ToolSet> {
    const targets = ids ?? this.ids();
    const merged: ToolSet = {};
    await Promise.all(
      targets.map(async (id) => {
        const entry = this.servers.get(id);
        if (!entry) return;
        const tools = await this.discover(entry);
        if (tools) Object.assign(merged, tools);
      }),
    );
    return merged;
  }

  /** Cached health for one server (no reconnect). Unknown id → null. */
  health(id: string): McpHealth | null {
    return this.servers.get(id)?.health ?? null;
  }

  /** Cached health for every registered server. */
  allHealth(): McpHealth[] {
    return [...this.servers.values()].map((e) => e.health);
  }

  /** Tear down one connection (idle/turn-end); its cached tool catalog is retained but its
   *  status drops to `disconnected`. No-op for an unknown id. */
  async close(id: string): Promise<void> {
    const entry = this.servers.get(id);
    if (!entry) return;
    await entry.connection.close();
    entry.health = { ...entry.health, status: 'disconnected', checkedAt: this.now() };
  }

  /** Tear down every connection (turn-end). */
  async closeAll(): Promise<void> {
    await Promise.all(this.ids().map((id) => this.close(id)));
  }

  // Discover a server's tools, updating its cached health. Returns the namespaced ToolSet
  // on success or null on failure (health set to `error`) — callers never see a throw.
  private async discover(entry: Entry): Promise<ToolSet | null> {
    const { id } = entry.spec;
    try {
      const tools = await entry.connection.tools();
      const names = Object.keys(tools);
      entry.health = {
        id,
        status: 'connected',
        toolCount: names.length,
        tools: names,
        checkedAt: this.now(),
      };
      return tools;
    } catch (err) {
      entry.health = {
        id,
        status: 'error',
        toolCount: 0,
        tools: [],
        error: err instanceof Error ? err.message : String(err),
        checkedAt: this.now(),
      };
      return null;
    }
  }
}
