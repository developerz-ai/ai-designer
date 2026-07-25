import type { MCPClientConfig } from '@ai-sdk/mcp';
import { type ToolSet, tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { McpClientFactory } from '@/mcp/client';
import { McpManager } from '@/mcp/manager';

// mcp/manager #17 unit: the per-server enabled flag gates every connection path — register
// stamps it onto health, setEnabled(false) tears the live connection down, connect() refuses
// a disabled server without opening, and toolsForShip skips a disabled server even when its id
// is named explicitly (a Ship pinned to a disabled backend must fall back, never silently open
// it). Same fake-client-factory pattern as mcp-client.test.ts; no chrome.* here.

/** A ToolSet whose keys are `names`, each a trivial static tool. */
function toolSet(...names: string[]): ToolSet {
  const set: ToolSet = {};
  for (const name of names) set[name] = tool({ description: name, inputSchema: z.object({}) });
  return set;
}

/** The MCP transport URL from a client config (the transport is always our HTTP literal). */
function urlOf(config: MCPClientConfig): string {
  const t = config.transport;
  return 'url' in t ? t.url : '';
}

const AI_DEV = { id: 'ai-dev', url: 'https://ai-dev/mcp' };
const GITHUB = { id: 'github', url: 'https://github/mcp' };

/** Shared factory branching on transport URL so servers can behave independently. */
function factory(byUrl: Record<string, ToolSet>) {
  const closes = new Map<string, ReturnType<typeof vi.fn>>();
  const connect = vi.fn<McpClientFactory>(async (config) => {
    const url = urlOf(config);
    const close = vi.fn(async (): Promise<void> => {});
    closes.set(url, close);
    return { tools: async () => byUrl[url] ?? {}, close };
  });
  return { connect, closes };
}

describe('McpManager enabled flag (#17)', () => {
  it('registers enabled by default, stamped onto health', async () => {
    const { connect } = factory({ [AI_DEV.url]: toolSet('task') });
    const mgr = new McpManager({ connect, idleMs: 0 });
    mgr.register(AI_DEV);

    expect(mgr.isEnabled('ai-dev')).toBe(true);
    expect(mgr.health('ai-dev')).toMatchObject({ enabled: true, status: 'disconnected' });

    // The flag survives a connect's health rebuild.
    const health = await mgr.connect('ai-dev');
    expect(health).toMatchObject({ enabled: true, status: 'connected' });
  });

  it('register(spec, {enabled:false}) keeps the server registered but never opens it', async () => {
    const { connect } = factory({ [AI_DEV.url]: toolSet('task') });
    const mgr = new McpManager({ connect, idleMs: 0 });
    mgr.register(AI_DEV, { enabled: false });

    expect(mgr.isEnabled('ai-dev')).toBe(false);
    expect(mgr.health('ai-dev')).toMatchObject({ enabled: false });
    expect(await mgr.connect('ai-dev')).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it('setEnabled(false) closes the live connection and drops health to disconnected', async () => {
    const { connect, closes } = factory({ [AI_DEV.url]: toolSet('task') });
    const mgr = new McpManager({ connect, idleMs: 0 });
    mgr.register(AI_DEV);
    await mgr.connect('ai-dev');
    expect(mgr.health('ai-dev')).toMatchObject({ status: 'connected' });

    expect(await mgr.setEnabled('ai-dev', false)).toBe(true);
    expect(closes.get(AI_DEV.url)).toHaveBeenCalledTimes(1);
    expect(mgr.isEnabled('ai-dev')).toBe(false);
    expect(mgr.health('ai-dev')).toMatchObject({ status: 'disconnected', enabled: false });
  });

  it('connect() refuses a disabled server — null, no open attempted', async () => {
    const { connect } = factory({ [AI_DEV.url]: toolSet('task') });
    const mgr = new McpManager({ connect, idleMs: 0 });
    mgr.register(AI_DEV);
    await mgr.connect('ai-dev');
    await mgr.setEnabled('ai-dev', false);
    connect.mockClear();

    expect(await mgr.connect('ai-dev')).toBeNull();
    expect(connect).not.toHaveBeenCalled(); // credentials/transport never touched
  });

  it('toolsForShip skips a disabled server even when its id is passed explicitly', async () => {
    const { connect } = factory({
      [AI_DEV.url]: toolSet('task'),
      [GITHUB.url]: toolSet('search'),
    });
    const mgr = new McpManager({ connect, idleMs: 0 });
    mgr.register(AI_DEV, { enabled: false });
    mgr.register(GITHUB);

    // Named explicitly — still skipped (a Ship pinned to a disabled backend falls back).
    expect(Object.keys(await mgr.toolsForShip(['ai-dev', 'github']))).toEqual(['github__search']);
    expect(urlsCalled(connect)).toEqual([GITHUB.url]);
  });

  it('re-enabling is lazy: the next connect() opens the server again', async () => {
    const { connect } = factory({ [AI_DEV.url]: toolSet('task') });
    const mgr = new McpManager({ connect, idleMs: 0 });
    mgr.register(AI_DEV, { enabled: false });

    expect(await mgr.setEnabled('ai-dev', true)).toBe(true);
    expect(mgr.health('ai-dev')).toMatchObject({ enabled: true, status: 'disconnected' });

    const health = await mgr.connect('ai-dev');
    expect(health).toMatchObject({ enabled: true, status: 'connected', toolCount: 1 });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('setEnabled on an unknown id returns false; isEnabled reads unknown as false', async () => {
    const { connect } = factory({});
    const mgr = new McpManager({ connect, idleMs: 0 });

    expect(await mgr.setEnabled('missing', false)).toBe(false);
    expect(await mgr.setEnabled('missing', true)).toBe(false);
    expect(mgr.isEnabled('missing')).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  it('a failed connect keeps the enabled flag on the error health record', async () => {
    const close = vi.fn(async (): Promise<void> => {});
    const connect = vi.fn<McpClientFactory>(async () => {
      throw new Error('down');
    });
    const mgr = new McpManager({ connect, idleMs: 0 });
    mgr.register(AI_DEV);

    const health = await mgr.connect('ai-dev');
    expect(health).toMatchObject({ status: 'error', error: 'down', enabled: true });
    expect(close).not.toHaveBeenCalled();
  });
});

/** The transport URLs a connect spy was called with, in order. */
function urlsCalled(connect: ReturnType<typeof vi.fn<McpClientFactory>>): string[] {
  return connect.mock.calls.map(([config]) => urlOf(config));
}
