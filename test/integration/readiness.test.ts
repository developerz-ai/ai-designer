// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { saveProviderConfig } from '@/agent/config-store';
import { computeReadiness } from '@/agent/readiness';
import { McpManager } from '@/mcp/manager';
import {
  type PanelToSw,
  PanelToSw as PanelToSwSchema,
  ReadinessResult,
  type SwToPanel,
  SwToPanel as SwToPanelSchema,
} from '@/shared/messages';

// Integration: a settings change reflects in the `readiness` RPC through the *real*
// cooperating modules (config-store + a real, unconnected McpManager) the way
// background.ts wires them — real WebCrypto (node env), a real (fake) IndexedDB, a fake
// chrome.storage.local/permissions.
//
// background.ts itself imports the WXT-virtual `#imports` module, which only resolves
// inside a WXT-built bundle — not plain Vitest (see provider-settings.test.ts for the
// same constraint). So this test reproduces the handler's `readiness`/`save-provider`
// sequence directly against the real modules, mirroring background.ts's `handle()` cases
// 1:1 (including the `pushReadiness` fan-out), rather than importing the entrypoint.

function installChromeFakes(opts: { grantedOrigins?: string[] } = {}): void {
  const storage = new Map<string, unknown>();
  const grantedOrigins = new Set(opts.grantedOrigins ?? []);
  const local = {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const names = keys == null ? [...storage.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (storage.has(name)) out[name] = storage.get(name);
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [name, value] of Object.entries(items)) storage.set(name, value);
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) storage.delete(k);
      return Promise.resolve();
    },
  };
  const permissions = {
    contains: (p: { origins?: string[] }) =>
      Promise.resolve((p.origins ?? []).every((o) => grantedOrigins.has(o))),
    request: (p: { origins?: string[] }) => {
      for (const o of p.origins ?? []) grantedOrigins.add(o);
      return Promise.resolve(true);
    },
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { local }, permissions };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // fresh empty IDB per test
});

describe('integration: readiness reflects config-store + MCP state through the bus', () => {
  it('reports not-ready before any provider is configured', async () => {
    installChromeFakes();
    const mcpManager = new McpManager();

    const inbound = PanelToSwSchema.parse({ type: 'readiness' });
    expect(inbound.type).toBe('readiness');

    const result = ReadinessResult.parse({ ok: true, state: await computeReadiness(mcpManager) });
    expect(result.state.ready).toBe(false);
    expect(result.state.provider).toBe('missing');
    expect(result.state.model).toBe('missing');
  });

  it('flips to ready once save-provider persists a key + model, mirrored as a pushed SwToPanel event', async () => {
    installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*'] });
    const mcpManager = new McpManager();

    await saveProviderConfig({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-integration',
      model: 'anthropic/claude-3.5-sonnet',
    });

    // Mirrors background.ts's `pushReadiness()` fan-out after a save-provider mutation.
    const pushedRaw: SwToPanel = SwToPanelSchema.parse({
      type: 'readiness',
      state: await computeReadiness(mcpManager),
    });
    if (pushedRaw.type !== 'readiness') throw new Error('unreachable');
    const pushed = pushedRaw;
    expect(pushed).toEqual({
      type: 'readiness',
      state: {
        provider: 'ok',
        model: 'ok',
        hostPermission: 'granted',
        mcp: { connected: 0, total: 0 },
        ready: true,
      },
    });

    // The RPC path (a fresh `readiness` request) reads back the same state.
    const rpcResult = ReadinessResult.parse({
      ok: true,
      state: await computeReadiness(mcpManager),
    });
    expect(rpcResult.state).toEqual(pushed.state);
  });

  it('session-start/session-stop round-trip through the bus schema', () => {
    const start: PanelToSw = PanelToSwSchema.parse({ type: 'session-start' });
    const stop: PanelToSw = PanelToSwSchema.parse({ type: 'session-stop' });
    expect(start.type).toBe('session-start');
    expect(stop.type).toBe('session-stop');

    for (const state of ['idle', 'running', 'stopped'] as const) {
      const event: SwToPanel = SwToPanelSchema.parse({ type: 'session-state', state });
      expect(event).toEqual({ type: 'session-state', state });
    }
  });
});
