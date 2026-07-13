// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getProviderConfig,
  hasProviderKey,
  migrateLegacyProvider,
  saveProviderConfig,
} from '@/agent/config-store';
import { encryptSecret } from '@/agent/key-store';
import { validateProvider } from '@/agent/provider';
import { ensureHostAccess } from '@/shared/host-permissions';
import {
  GetProviderResult,
  type PanelToSw,
  PanelToSw as PanelToSwSchema,
  SaveProviderResult,
} from '@/shared/messages';

// Integration: the panel<->SW settings RPCs (save-provider / get-provider), exercised
// through the *real* cooperating modules (messages schemas + config-store + key-store +
// provider + host-permissions) the way entrypoints/background.ts wires them, end to end —
// real WebCrypto (node env), a real (fake) IndexedDB, a fake chrome.storage.local /
// chrome.permissions, and a stubbed fetch for the provider's /models probe.
//
// background.ts itself imports the WXT-virtual `#imports` module, which only resolves
// inside a WXT-built bundle — not plain Vitest (see test/integration/transport.test.ts for
// the same constraint on the SW's other push path). So this test reproduces the handler's
// save-provider/get-provider sequence directly against the real modules, mirroring
// background.ts's `handle()` cases 1:1, rather than importing the entrypoint.

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

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
      for (const o of p.origins ?? []) grantedOrigins.add(o); // this suite always grants
      return Promise.resolve(true);
    },
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { local }, permissions };
}

function stubModelsEndpoint(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })),
  );
}

// Mirrors background.ts's `case 'save-provider'` — see file header.
async function handleSaveProvider(config: PanelToSw & { type: 'save-provider' }) {
  const access = await ensureHostAccess(config.config.baseURL);
  if (!access.ok) return SaveProviderResult.parse({ ok: true, valid: false, error: access.error });
  await saveProviderConfig(config.config);
  const saved = await getProviderConfig();
  const result = saved ? await validateProvider(saved) : { ok: false, error: undefined };
  return SaveProviderResult.parse({ ok: true, valid: result.ok, error: result.error });
}

// Mirrors background.ts's `case 'get-provider'` — apiKey is stripped before it ever
// reaches the schema, not merely omitted by the schema.
async function handleGetProvider() {
  const cfg = await getProviderConfig();
  const config = cfg ? { baseURL: cfg.baseURL, model: cfg.model, label: cfg.label } : undefined;
  return GetProviderResult.parse({ ok: true, config, hasKey: await hasProviderKey() });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // fresh empty IDB per test
});

afterEach(() => {
  vi.unstubAllGlobals();
  (globalThis as { chrome?: unknown }).chrome = undefined;
});

describe('integration: save-provider -> get-provider round trip through the bus', () => {
  it('parses a save-provider RPC, persists it, and reads it back via get-provider', async () => {
    installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*'] });
    stubModelsEndpoint();

    const inbound = PanelToSwSchema.parse({
      type: 'save-provider',
      config: {
        baseURL: OPENROUTER_BASE_URL,
        apiKey: 'sk-or-v1-round-trip',
        model: 'anthropic/claude-3.5-sonnet',
        label: 'OpenRouter',
      },
    });
    expect(inbound.type).toBe('save-provider');
    if (inbound.type !== 'save-provider') throw new Error('unreachable');

    const saveResult = await handleSaveProvider(inbound);
    expect(saveResult).toEqual({ ok: true, valid: true, error: undefined });

    const getResult = await handleGetProvider();
    expect(getResult).toEqual({
      ok: true,
      hasKey: true,
      config: {
        baseURL: OPENROUTER_BASE_URL,
        model: 'anthropic/claude-3.5-sonnet',
        label: 'OpenRouter',
      },
    });
    // The bus response never carries the key value, even though it round-tripped.
    expect(JSON.stringify(getResult)).not.toContain('sk-or-v1-round-trip');
  });

  it('requests a runtime host grant for a not-yet-permitted custom host before persisting', async () => {
    installChromeFakes(); // nothing granted yet
    stubModelsEndpoint();

    const result = await handleSaveProvider({
      type: 'save-provider',
      config: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
    });

    expect(result).toEqual({ ok: true, valid: true, error: undefined });
    expect(await getProviderConfig()).toEqual({
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });
  });

  it('denies the save and persists nothing when the host grant is refused', async () => {
    installChromeFakes();
    (globalThis as unknown as { chrome: typeof chrome }).chrome.permissions.request = (() =>
      Promise.resolve(false)) as typeof chrome.permissions.request;
    stubModelsEndpoint();

    const result = await handleSaveProvider({
      type: 'save-provider',
      config: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
    });

    expect(result.ok).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('https://api.openai.com/*');
    expect(await getProviderConfig()).toBeNull(); // nothing was persisted
  });

  it('reports valid:false without erroring when the endpoint is unreachable (offline local server)', async () => {
    installChromeFakes({ grantedOrigins: ['http://localhost/*'] });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('failed to fetch'))),
    );

    const result = await handleSaveProvider({
      type: 'save-provider',
      config: { baseURL: 'http://localhost:1234/v1', model: 'local-model' },
    });

    // Persisted regardless — reachability is informational, not a precondition for saving.
    expect(result).toEqual({ ok: true, valid: false, error: undefined });
    expect(await getProviderConfig()).toEqual({
      baseURL: 'http://localhost:1234/v1',
      model: 'local-model',
    });
  });

  it('get-provider reports no config / no key on a fresh install', async () => {
    installChromeFakes();
    expect(await handleGetProvider()).toEqual({ ok: true, hasKey: false, config: undefined });
  });
});

describe('integration: legacy OpenRouter install migrates before any settings RPC is served', () => {
  it('a pre-ProviderConfig key + selected model becomes a usable config via get-provider', async () => {
    installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*'] });

    // Seed the pre-refactor shape directly (bare payload under `openrouter-key`, no
    // `secret:` namespace; model under `selected-model`) — see config-store.ts.
    await chrome.storage.local.set({
      'openrouter-key': await encryptSecret('sk-or-v1-legacy-user'),
      'selected-model': 'anthropic/claude-3.5-sonnet',
    });

    // background.ts awaits this once at startup, before handling any PanelToSw message.
    await migrateLegacyProvider();

    const getResult = await handleGetProvider();
    expect(getResult).toEqual({
      ok: true,
      hasKey: true,
      config: {
        baseURL: OPENROUTER_BASE_URL,
        model: 'anthropic/claude-3.5-sonnet',
        label: 'OpenRouter',
      },
    });
    expect(JSON.stringify(getResult)).not.toContain('sk-or-v1-legacy-user');

    // The legacy records are retired — migration runs exactly once.
    const all = await chrome.storage.local.get(null);
    expect(Object.keys(all)).not.toContain('openrouter-key');
    expect(Object.keys(all)).not.toContain('selected-model');
  });

  it('a migrated key is immediately usable through save-provider (model-only re-save)', async () => {
    installChromeFakes({ grantedOrigins: ['https://openrouter.ai/*'] });
    stubModelsEndpoint();
    await chrome.storage.local.set({
      'openrouter-key': await encryptSecret('sk-or-v1-legacy-user'),
    });

    await migrateLegacyProvider(); // key ported; no model was ever selected -> no config yet
    expect(await handleGetProvider()).toEqual({ ok: true, hasKey: true, config: undefined });

    // The user picks a model in the panel; save-provider carries no apiKey (presence-only
    // placeholder), so the ported key must survive this save untouched.
    const result = await handleSaveProvider({
      type: 'save-provider',
      config: { baseURL: OPENROUTER_BASE_URL, model: 'openai/gpt-4o', label: 'OpenRouter' },
    });
    expect(result).toEqual({ ok: true, valid: true, error: undefined });

    const getResult = await handleGetProvider();
    expect(getResult.config).toEqual({
      baseURL: OPENROUTER_BASE_URL,
      model: 'openai/gpt-4o',
      label: 'OpenRouter',
    });
    expect(getResult.hasKey).toBe(true);
  });

  it('never clobbers a key/config already saved under the new scheme', async () => {
    installChromeFakes({ grantedOrigins: ['https://api.openai.com/*'] });
    stubModelsEndpoint();
    await saveProviderConfig({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-new-user-key',
      model: 'gpt-4o',
    });
    await chrome.storage.local.set({
      'openrouter-key': await encryptSecret('sk-or-v1-legacy-ignored'),
    });

    await migrateLegacyProvider();

    const getResult = await handleGetProvider();
    expect(getResult.config).toEqual({ baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' });
    const all = await chrome.storage.local.get(null);
    expect(Object.keys(all)).not.toContain('openrouter-key'); // still retired, just not applied
  });
});
