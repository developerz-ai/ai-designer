import type { MCPClientConfig } from '@ai-sdk/mcp';
import { type ToolSet, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createConnection, type McpClientFactory, namespaceTool } from '@/mcp/client';
import { McpManager } from '@/mcp/manager';

// mcp/client + mcp/manager unit: the AI SDK MCP client is faked (no HTTP server), so this
// asserts lazy open, `<id>__<tool>` namespacing, catalog caching, the #165 S2 lifecycle
// (no idle close, leases deferring a close under an in-flight call, connect/close deadlines),
// and per-server health isolation without a real backend. SW-only modules; no chrome.* here.

/** A ToolSet whose keys are `names`, each a trivial static tool. */
function toolSet(...names: string[]): ToolSet {
  const set: ToolSet = {};
  for (const name of names) set[name] = tool({ description: name, inputSchema: z.object({}) });
  return set;
}

/** The `ToolCallOptions` an SDK tool's `execute` takes — none of it matters to the lease wrapper. */
function callOptions() {
  return { toolCallId: 't1', messages: [], context: undefined };
}

/** An externally-settled promise, standing in for a backend call that outlives the caller. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The MCP transport URL from a client config (the transport is always our HTTP literal). */
function urlOf(config: MCPClientConfig): string {
  const t = config.transport;
  return 'url' in t ? t.url : '';
}

/** A factory returning one fake client with spy-able `tools`/`close`. */
function fakeFactory(tools: ToolSet = toolSet('task', 'kb')) {
  const close = vi.fn(async (): Promise<void> => {});
  const toolsFn = vi.fn(async (): Promise<ToolSet> => tools);
  const connect = vi.fn<McpClientFactory>(async () => ({ tools: toolsFn, close }));
  return { connect, toolsFn, close };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('namespaceTool', () => {
  it('prefixes the tool with `<serverId>__`', () => {
    expect(namespaceTool('ai-dev', 'task')).toBe('ai-dev__task');
  });

  it('sanitizes the id segment to a provider-safe token', () => {
    expect(namespaceTool('a.b', 'run')).toBe('a_b__run');
    expect(namespaceTool('has space', 'x')).toBe('has_space__x');
  });
});

describe('createConnection', () => {
  it('requires an id and url', () => {
    expect(() => createConnection({ id: '', url: 'https://x/mcp' })).toThrow(/id/);
    expect(() => createConnection({ id: 'a', url: '' })).toThrow(/url/);
  });

  it('opens lazily — nothing connects until tools() is called', async () => {
    const { connect } = fakeFactory();
    const conn = createConnection({ id: 'ai-dev', url: 'https://x/mcp' }, { connect });
    expect(connect).not.toHaveBeenCalled();
    expect(conn.isOpen()).toBe(false);

    await conn.tools();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(conn.isOpen()).toBe(true);
  });

  it('namespaces discovered tools `<id>__<tool>`', async () => {
    const { connect } = fakeFactory(toolSet('task', 'kb'));
    const conn = createConnection({ id: 'ai-dev', url: 'https://x/mcp' }, { connect });
    expect(Object.keys(await conn.tools())).toEqual(['ai-dev__task', 'ai-dev__kb']);
  });

  it('caches the open client + catalog across repeated tools() calls', async () => {
    const { connect, toolsFn } = fakeFactory();
    const conn = createConnection({ id: 'ai-dev', url: 'https://x/mcp' }, { connect });
    await conn.tools();
    await conn.tools();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(toolsFn).toHaveBeenCalledTimes(1);
  });

  it('passes resolved getHeaders() to the transport, refreshing per open', async () => {
    const { connect } = fakeFactory();
    const getHeaders = vi
      .fn()
      .mockResolvedValueOnce({ Authorization: 'Bearer one' })
      .mockResolvedValueOnce({ Authorization: 'Bearer two' });
    const conn = createConnection({ id: 'ai-dev', url: 'https://x/mcp', getHeaders }, { connect });

    await conn.tools();
    await conn.close();
    await conn.tools();

    expect(connect.mock.calls[0]?.[0].transport).toMatchObject({
      type: 'http',
      url: 'https://x/mcp',
      headers: { Authorization: 'Bearer one' },
    });
    expect(connect.mock.calls[1]?.[0].transport).toMatchObject({
      headers: { Authorization: 'Bearer two' },
    });
  });

  it('falls back to static headers when no resolver is given', async () => {
    const { connect } = fakeFactory();
    const conn = createConnection(
      { id: 'ai-dev', url: 'https://x/mcp', headers: { 'X-Key': 'k' } },
      { connect },
    );
    await conn.tools();
    expect(connect.mock.calls[0]?.[0].transport).toMatchObject({ headers: { 'X-Key': 'k' } });
  });

  it('closes the underlying client and reopens on the next tools()', async () => {
    const { connect, close } = fakeFactory();
    const conn = createConnection({ id: 'ai-dev', url: 'https://x/mcp' }, { connect });
    await conn.tools();
    await conn.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(conn.isOpen()).toBe(false);

    await conn.tools();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed open — the next call retries', async () => {
    const close = vi.fn(async (): Promise<void> => {});
    const connect = vi
      .fn<McpClientFactory>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ tools: async () => toolSet('task'), close });
    const conn = createConnection({ id: 'ai-dev', url: 'https://x/mcp' }, { connect });

    await expect(conn.tools()).rejects.toThrow('down');
    expect(conn.isOpen()).toBe(false);
    expect(Object.keys(await conn.tools())).toEqual(['ai-dev__task']);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  // #165 S2 — the shipped bug: an idle timer armed when `tools()` resolved and never reset by tool
  // EXECUTION (the SDK's tool objects call `client.callTool` directly, bypassing the wrapper) tore
  // the transport down 60s after discovery, while the model still held the tool closures. Every
  // existing test constructed connections with `idleMs: 0`, which is exactly why it shipped — so
  // these run at the DEFAULT lifecycle, with no idle option to opt out of.
  it('keeps the connection open indefinitely with no calls (no idle close)', async () => {
    vi.useFakeTimers();
    const { connect, close } = fakeFactory();
    const conn = createConnection({ id: 'ai-dev', url: 'https://x/mcp' }, { connect });
    await conn.tools();

    // Well past the old 60s window and then some — a design turn routinely runs minutes.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(close).not.toHaveBeenCalled();
    expect(conn.isOpen()).toBe(true);
  });

  it('a tool held from an earlier discovery still executes minutes later', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => ({ ok: true }));
    const { connect } = fakeFactory({
      task: tool({ description: 'task', inputSchema: z.object({}), execute }),
    });
    const conn = createConnection({ id: 'ai-dev', url: 'https://x/mcp' }, { connect });
    // The turn builds its ToolSet once, at t=0 — exactly what background.ts's `toolsFor()` does.
    const held = (await conn.tools())['ai-dev__task'];

    await vi.advanceTimersByTimeAsync(90_000);
    await expect(held?.execute?.({}, callOptions())).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('defers close() under an in-flight tool call, then closes on its release', async () => {
    // A long-poll standing in for Ship's `task(watch)` — it always outlives a minute.
    const watch = deferred<{ status: string }>();
    const { connect, close } = fakeFactory({
      task: tool({ description: 'task', inputSchema: z.object({}), execute: () => watch.promise }),
    });
    const conn = createConnection({ id: 'ai-dev', url: 'https://x/mcp' }, { connect });
    const held = (await conn.tools())['ai-dev__task'];

    const call = held?.execute?.({}, callOptions()) as Promise<unknown>;
    await conn.close(); // a disable/unregister landing mid-watch
    expect(close).not.toHaveBeenCalled();
    expect(conn.isOpen()).toBe(true);

    watch.resolve({ status: 'pr_open' });
    await expect(call).resolves.toEqual({ status: 'pr_open' });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(conn.isOpen()).toBe(false);
  });

  it('releases the lease when a tool call rejects, so a deferred close still lands', async () => {
    const { connect, close } = fakeFactory({
      task: tool({
        description: 'task',
        inputSchema: z.object({}),
        execute: async (): Promise<{ ok: boolean }> => {
          throw new Error('backend said no');
        },
      }),
    });
    const conn = createConnection({ id: 'ai-dev', url: 'https://x/mcp' }, { connect });
    const held = (await conn.tools())['ai-dev__task'];

    const call = held?.execute?.({}, callOptions()) as Promise<unknown>;
    await conn.close();
    await expect(call).rejects.toThrow('backend said no');
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('fails discovery on the connect deadline and retries on the next call', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async (): Promise<void> => {});
    const connect = vi
      .fn<McpClientFactory>()
      .mockImplementationOnce(() => new Promise(() => {})) // never settles
      .mockResolvedValueOnce({ tools: async () => toolSet('task'), close });
    const conn = createConnection(
      { id: 'ai-dev', url: 'https://x/mcp' },
      { connect, connectTimeoutMs: 1000 },
    );

    // Assert BEFORE advancing: the rejection lands inside `advanceTimersByTimeAsync`, and a
    // handler attached after it would make the run report an unhandled rejection.
    const first = expect(conn.tools()).rejects.toThrow(/did not respond/);
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(Object.keys(await conn.tools())).toEqual(['ai-dev__task']);
  });

  it('gives up on a wedged close rather than blocking the caller', async () => {
    vi.useFakeTimers();
    const connect = vi.fn<McpClientFactory>(async () => ({
      tools: async () => toolSet('task'),
      close: () => new Promise<void>(() => {}), // teardown never settles
    }));
    const conn = createConnection(
      { id: 'ai-dev', url: 'https://x/mcp' },
      { connect, closeTimeoutMs: 500 },
    );
    await conn.tools();

    const closing = conn.close();
    await vi.advanceTimersByTimeAsync(500);
    await expect(closing).resolves.toBeUndefined();
    expect(conn.isOpen()).toBe(false);
  });
});

describe('McpManager', () => {
  const AI_DEV = { id: 'ai-dev', url: 'https://ai-dev/mcp' };
  const GITHUB = { id: 'github', url: 'https://github/mcp' };

  /** Shared factory branching on transport URL so servers can behave independently. */
  function factory(byUrl: Record<string, ToolSet | Error>) {
    const closes = new Map<string, ReturnType<typeof vi.fn>>();
    const connect = vi.fn<McpClientFactory>(async (config) => {
      const url = urlOf(config);
      const outcome = byUrl[url];
      if (outcome instanceof Error) throw outcome;
      const close = vi.fn(async (): Promise<void> => {});
      closes.set(url, close);
      return { tools: async () => outcome ?? {}, close };
    });
    return { connect, closes };
  }

  it('connect() discovers + caches namespaced health', async () => {
    const { connect } = factory({ [AI_DEV.url]: toolSet('task', 'kb') });
    const mgr = new McpManager({ connect, now: () => 42 });
    mgr.register(AI_DEV);

    expect(mgr.health('ai-dev')).toMatchObject({ status: 'disconnected', toolCount: 0 });
    const health = await mgr.connect('ai-dev');
    expect(health).toMatchObject({
      id: 'ai-dev',
      status: 'connected',
      toolCount: 2,
      tools: ['ai-dev__task', 'ai-dev__kb'],
      checkedAt: 42,
    });
    expect(mgr.health('ai-dev')).toEqual(health);
  });

  it('toolsForShip() merges every server, namespaced — write tools included', async () => {
    const { connect } = factory({
      [AI_DEV.url]: toolSet('task'),
      [GITHUB.url]: toolSet('search'),
    });
    const mgr = new McpManager({ connect });
    mgr.register(AI_DEV);
    mgr.register(GITHUB);

    expect(Object.keys(await mgr.toolsForShip()).sort()).toEqual([
      'ai-dev__task',
      'github__search',
    ]);
  });

  it('toolsFor() is design-safe by default: write tools stripped, read tools kept (#117)', async () => {
    const { connect } = factory({
      [AI_DEV.url]: toolSet('task', 'kb'),
      [GITHUB.url]: toolSet('search'),
    });
    const mgr = new McpManager({ connect });
    mgr.register(AI_DEV);
    mgr.register(GITHUB);

    expect(Object.keys(await mgr.toolsFor()).sort()).toEqual(['ai-dev__kb', 'github__search']);
  });

  it('isolates a failing server: it degrades to error, others still merge', async () => {
    const { connect } = factory({
      [AI_DEV.url]: toolSet('task'),
      [GITHUB.url]: new Error('401 unauthorized'),
    });
    const mgr = new McpManager({ connect });
    mgr.register(AI_DEV);
    mgr.register(GITHUB);

    expect(Object.keys(await mgr.toolsForShip())).toEqual(['ai-dev__task']);
    expect(mgr.health('github')).toMatchObject({ status: 'error', error: '401 unauthorized' });
    expect(mgr.health('ai-dev')).toMatchObject({ status: 'connected' });
  });

  it('toolsForShip(ids) restricts the merge to the given servers', async () => {
    const { connect } = factory({
      [AI_DEV.url]: toolSet('task'),
      [GITHUB.url]: toolSet('search'),
    });
    const mgr = new McpManager({ connect });
    mgr.register(AI_DEV);
    mgr.register(GITHUB);

    expect(Object.keys(await mgr.toolsForShip(['ai-dev']))).toEqual(['ai-dev__task']);
  });

  it('closeAll() tears down connections and marks them disconnected', async () => {
    const { connect, closes } = factory({ [AI_DEV.url]: toolSet('task') });
    const mgr = new McpManager({ connect });
    mgr.register(AI_DEV);
    await mgr.connect('ai-dev');

    await mgr.closeAll();
    expect(closes.get(AI_DEV.url)).toHaveBeenCalledTimes(1);
    expect(mgr.health('ai-dev')).toMatchObject({ status: 'disconnected' });
  });

  it('unregister() removes and tears down; unknown ids are null/no-op', async () => {
    const { connect } = factory({ [AI_DEV.url]: toolSet('task') });
    const mgr = new McpManager({ connect });
    mgr.register(AI_DEV);
    await mgr.unregister('ai-dev');

    expect(mgr.has('ai-dev')).toBe(false);
    expect(await mgr.connect('missing')).toBeNull();
    expect(mgr.health('missing')).toBeNull();
    expect(await mgr.toolsFor(['missing'])).toEqual({});
  });
});
