// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProviderConfig, saveProviderConfig } from '@/agent/config-store';
import {
  keyMissing,
  MISSING_KEY_ERROR,
  REJECTED_KEY_ERROR,
  validateProvider,
} from '@/agent/provider';
import { computeReadiness, type McpHealthSource } from '@/agent/readiness';

// Integration: the "Missing Authentication header" regression, end to end through the REAL
// cooperating modules (config-store + key-store WebCrypto + provider probe + readiness), the way
// background.ts wires them.
//
// What used to happen: a user saved an OpenRouter base URL + model without a key (or cleared the
// key later). `validateProvider` probed `/models` — which OpenRouter serves PUBLICLY — got a 200,
// and Settings reported "saved and reachable". `computeReadiness` only checked baseURL + model, so
// every row was green and Start was enabled. The first model call then went out with no
// Authorization header and OpenRouter answered `AI_APICallError: Missing Authentication header`,
// several frames deep in the AI SDK stream, followed by an unhandled `AI_NoOutputGeneratedError`.
//
// Three independent gates now catch it, and this exercises all three against one stored config.

const OPENROUTER = 'https://openrouter.ai/api/v1';

function installChromeFakes(opts: { grantedOrigins?: string[] } = {}): void {
  const storage = new Map<string, unknown>();
  const granted = new Set(opts.grantedOrigins ?? []);
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
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local },
    permissions: {
      contains: (p: { origins?: string[] }) =>
        Promise.resolve((p.origins ?? []).every((o) => granted.has(o))),
    },
  };
}

const noMcp: McpHealthSource = { allHealth: () => [] };

/** OpenRouter's real shape: `/models` is public (200 with no key), `/key` requires auth. */
function stubOpenRouter(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'a', name: 'A' }] }) };
    }
    if (url.endsWith('/key')) {
      return { ok: false, status: 401, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*'] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  (globalThis as { chrome?: unknown }).chrome = undefined;
});

describe('integration: a keyless hosted provider is caught before it can 401 mid-turn', () => {
  it('save-time: validate rejects it by name and never issues the doomed request', async () => {
    const fetchMock = stubOpenRouter();
    await saveProviderConfig({ baseURL: OPENROUTER, model: 'minimax/hailuo-3' });

    const saved = await getProviderConfig();
    expect(saved).not.toBeNull();
    expect(saved?.apiKey).toBeUndefined(); // nothing in the key-store to decrypt

    expect(await validateProvider(saved ?? { baseURL: OPENROUTER })).toEqual({
      ok: false,
      error: MISSING_KEY_ERROR,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('start-time: readiness reports apiKey missing and refuses `ready`', async () => {
    await saveProviderConfig({ baseURL: OPENROUTER, model: 'minimax/hailuo-3' });
    const state = await computeReadiness(noMcp);
    expect(state.provider).toBe('ok');
    expect(state.model).toBe('ok');
    expect(state.apiKey).toBe('missing');
    expect(state.ready).toBe(false);
  });

  it('turn-time: the guard background.ts runs before createProvider agrees', async () => {
    await saveProviderConfig({ baseURL: OPENROUTER, model: 'minimax/hailuo-3' });
    const cfg = await getProviderConfig();
    expect(cfg && keyMissing(cfg)).toBe(true);
  });

  it('all three clear once a key is stored — and the probe is the auth-requiring one', async () => {
    const fetchMock = stubOpenRouter();
    await saveProviderConfig({
      baseURL: OPENROUTER,
      apiKey: 'sk-or-v1-real',
      model: 'minimax/hailuo-3',
    });
    const cfg = await getProviderConfig();
    expect(cfg?.apiKey).toBe('sk-or-v1-real'); // decrypted back out of the key-store
    expect(cfg && keyMissing(cfg)).toBe(false);
    expect((await computeReadiness(noMcp)).apiKey).toBe('ok');
    expect((await computeReadiness(noMcp)).ready).toBe(true);

    // The stub 401s `/key`, so a green verdict here would mean we probed the PUBLIC `/models`
    // instead — the exact false-positive that let a bad key through.
    expect(await validateProvider(cfg ?? { baseURL: OPENROUTER })).toEqual({
      ok: false,
      error: REJECTED_KEY_ERROR,
    });
    expect(fetchMock).toHaveBeenCalledWith(`${OPENROUTER}/key`, {
      headers: { Authorization: 'Bearer sk-or-v1-real' },
    });
  });
});
