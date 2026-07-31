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
    const mgr = new McpManager({ connect });
    mgr.register(AI_DEV);

    expect(mgr.isEnabled('ai-dev')).toBe(true);
    expect(mgr.health('ai-dev')).toMatchObject({ enabled: true, status: 'disconnected' });

    // The flag survives a connect's health rebuild.
    const health = await mgr.connect('ai-dev');
    expect(health).toMatchObject({ enabled: true, status: 'connected' });
  });

  it('register(spec, {enabled:false}) keeps the server registered but never opens it', async () => {
    const { connect } = factory({ [AI_DEV.url]: toolSet('task') });
    const mgr = new McpManager({ connect });
    mgr.register(AI_DEV, { enabled: false });

    expect(mgr.isEnabled('ai-dev')).toBe(false);
    expect(mgr.health('ai-dev')).toMatchObject({ enabled: false });
    expect(await mgr.connect('ai-dev')).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it('setEnabled(false) closes the live connection and drops health to disconnected', async () => {
    const { connect, closes } = factory({ [AI_DEV.url]: toolSet('task') });
    const mgr = new McpManager({ connect });
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
    const mgr = new McpManager({ connect });
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
    const mgr = new McpManager({ connect });
    mgr.register(AI_DEV, { enabled: false });
    mgr.register(GITHUB);

    // Named explicitly — still skipped (a Ship pinned to a disabled backend falls back).
    expect(Object.keys(await mgr.toolsForShip(['ai-dev', 'github']))).toEqual(['github__search']);
    expect(urlsCalled(connect)).toEqual([GITHUB.url]);
  });

  it('re-enabling is lazy: the next connect() opens the server again', async () => {
    const { connect } = factory({ [AI_DEV.url]: toolSet('task') });
    const mgr = new McpManager({ connect });
    mgr.register(AI_DEV, { enabled: false });

    expect(await mgr.setEnabled('ai-dev', true)).toBe(true);
    expect(mgr.health('ai-dev')).toMatchObject({ enabled: true, status: 'disconnected' });

    const health = await mgr.connect('ai-dev');
    expect(health).toMatchObject({ enabled: true, status: 'connected', toolCount: 1 });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('setEnabled on an unknown id returns false; isEnabled reads unknown as false', async () => {
    const { connect } = factory({});
    const mgr = new McpManager({ connect });

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
    const mgr = new McpManager({ connect });
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

// mcp/manager #120 unit: per-tool opt-in grants flow through the injected `grantsFor` and gate
// EACH SERVER's write-shaped tools before the design-turn merge. Server A exposes
// search/deploy/task, server B get_stats/publish — the merge must ungate exactly the granted
// base names of THAT server, never the sibling's, and `task` stays hard-stripped regardless.
// The execute pin is the AC's "cannot execute without explicit user opt-in": an ungranted
// write tool never reaches the merged set, so there is nothing for the loop to call.

const SRV_A = { id: 'srv-a', url: 'https://srv-a/mcp' };
const SRV_B = { id: 'srv-b', url: 'https://srv-b/mcp' };

type ExecuteSpy = ReturnType<typeof vi.fn<(input: unknown) => Promise<{ ok: boolean }>>>;

/** A trivial static tool whose execute is a spy (the granted/ungranted execution pin). */
function spyTool(name: string, execute: ExecuteSpy) {
  return tool({ description: name, inputSchema: z.object({}), execute });
}

/** Two-server harness: A = search + deploy(+execute spy) + task; B = get_stats + publish(+spy). */
function twoServerGrants() {
  const aDeploy = vi.fn(async (_input: unknown) => ({ ok: true }));
  const bPublish = vi.fn(async (_input: unknown) => ({ ok: true }));
  const { connect } = factory({
    [SRV_A.url]: {
      search: tool({ description: 'search', inputSchema: z.object({}) }),
      deploy: spyTool('deploy', aDeploy),
      task: tool({ description: 'task', inputSchema: z.object({}) }),
    },
    [SRV_B.url]: {
      get_stats: tool({ description: 'get_stats', inputSchema: z.object({}) }),
      publish: spyTool('publish', bPublish),
    },
  });
  return { connect, aDeploy, bPublish };
}

/** Invoke a merged tool's execute the way the agent loop would (guard mirrors callExecute
 *  in control-tools.test.ts — a ToolSet member's execute is optional on the type). */
async function callMerged(
  tools: ToolSet,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const entry = tools[name];
  const execute = entry && 'execute' in entry ? entry.execute : undefined;
  if (typeof execute !== 'function') throw new Error(`merged tool ${name} has no execute`);
  return execute(input, { toolCallId: 'call-1', messages: [], context: {} });
}

describe('McpManager per-tool grants (#120)', () => {
  it("grants for server A only ungate A's write tool — never B's", async () => {
    const { connect } = twoServerGrants();
    const mgr = new McpManager({
      connect,
      grantsFor: async (id) => (id === SRV_A.id ? ['deploy'] : []),
    });
    mgr.register(SRV_A);
    mgr.register(SRV_B);

    expect(Object.keys(await mgr.toolsFor())).toEqual([
      'srv-a__search',
      'srv-a__deploy',
      'srv-b__get_stats',
    ]);
  });

  it('with no grantsFor option, every write-shaped tool is gated but reads still merge', async () => {
    const { connect } = twoServerGrants();
    const mgr = new McpManager({ connect });
    mgr.register(SRV_A);
    mgr.register(SRV_B);

    expect(Object.keys(await mgr.toolsFor())).toEqual(['srv-a__search', 'srv-b__get_stats']);
  });

  it('`task` stays hard-stripped even when grantsFor "grants" it; toolsForShip still sees it', async () => {
    const { connect } = twoServerGrants();
    const mgr = new McpManager({
      connect,
      grantsFor: async () => ['task', 'deploy', 'publish'],
    });
    mgr.register(SRV_A);
    mgr.register(SRV_B);

    const design = await mgr.toolsFor();
    expect(Object.keys(design)).toEqual([
      'srv-a__search',
      'srv-a__deploy',
      'srv-b__get_stats',
      'srv-b__publish',
    ]);
    expect(design['srv-a__task']).toBeUndefined();

    // Ship is the one sanctioned dispatch path — its merge is unfiltered.
    expect(Object.keys(await mgr.toolsForShip())).toContain('srv-a__task');
  });

  it('an ungranted write tool never reaches the merge, so its execute cannot fire', async () => {
    const { connect, aDeploy, bPublish } = twoServerGrants();
    const mgr = new McpManager({ connect }); // no grantsFor
    mgr.register(SRV_A);
    mgr.register(SRV_B);

    const design = await mgr.toolsFor();
    expect(design['srv-a__deploy']).toBeUndefined();
    expect(design['srv-b__publish']).toBeUndefined();
    await expect(callMerged(design, 'srv-a__deploy', {})).rejects.toThrow(/no execute/);
    expect(aDeploy).not.toHaveBeenCalled();
    expect(bPublish).not.toHaveBeenCalled();
  });

  it('a granted write tool merges and its execute fires when the loop calls it', async () => {
    const { connect, aDeploy } = twoServerGrants();
    const mgr = new McpManager({
      connect,
      grantsFor: async (id) => (id === SRV_A.id ? ['deploy'] : []),
    });
    mgr.register(SRV_A);
    mgr.register(SRV_B);

    const design = await mgr.toolsFor();
    await expect(callMerged(design, 'srv-a__deploy', { env: 'prod' })).resolves.toEqual({
      ok: true,
    });
    expect(aDeploy).toHaveBeenCalledTimes(1);
    expect(aDeploy).toHaveBeenCalledWith(
      { env: 'prod' },
      expect.objectContaining({ toolCallId: 'call-1' }),
    );
  });

  it('grants are re-read on every toolsFor call — a revoke takes effect on the NEXT turn', async () => {
    const { connect } = twoServerGrants();
    let granted: Record<string, string[]> = { [SRV_A.id]: ['deploy'] };
    const mgr = new McpManager({
      connect,
      grantsFor: async (id) => granted[id] ?? [],
    });
    mgr.register(SRV_A);
    mgr.register(SRV_B);

    expect(Object.keys(await mgr.toolsFor())).toContain('srv-a__deploy');

    granted = {}; // the user revoked between turns
    expect(Object.keys(await mgr.toolsFor())).not.toContain('srv-a__deploy');
  });

  it('a granted write tool on a DISABLED server stays out — grants never resurrect it', async () => {
    const { connect } = twoServerGrants();
    const mgr = new McpManager({
      connect,
      grantsFor: async () => ['deploy', 'publish'],
    });
    mgr.register(SRV_A);
    mgr.register(SRV_B, { enabled: false });

    expect(Object.keys(await mgr.toolsFor())).toEqual(['srv-a__search', 'srv-a__deploy']);
  });

  it("toolsForShip merges every server's tools regardless of grants (Ship semantics unchanged)", async () => {
    const { connect } = twoServerGrants();
    const mgr = new McpManager({ connect }); // no grantsFor at all
    mgr.register(SRV_A);
    mgr.register(SRV_B);

    expect(Object.keys(await mgr.toolsForShip())).toEqual([
      'srv-a__search',
      'srv-a__deploy',
      'srv-a__task',
      'srv-b__get_stats',
      'srv-b__publish',
    ]);
  });
});
