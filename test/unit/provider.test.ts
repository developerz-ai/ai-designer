import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProvider,
  listModels,
  type ProviderEndpoint,
  validateProvider,
} from '@/agent/provider';

// provider.ts unit: network is stubbed via a fake fetch, so this asserts the base-URL
// join, the auth header, and response parsing without a real endpoint. No chrome.* here.

const OPENAI: ProviderEndpoint = { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test' };

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider: validateProvider', () => {
  it('GETs {baseURL}/models with a Bearer header and returns ok on 2xx', async () => {
    fetchMock.mockResolvedValue(response({ data: [] }));
    expect(await validateProvider(OPENAI)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/models', {
      headers: { Authorization: 'Bearer sk-test' },
    });
  });

  it('respects a custom keyless baseURL and trims a trailing slash', async () => {
    fetchMock.mockResolvedValue(response({ data: [] }));
    await validateProvider({ baseURL: 'http://localhost:1234/v1/' });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:1234/v1/models', {
      headers: undefined,
    });
  });

  it('reports a definitive rejection carrying the status on a non-2xx', async () => {
    fetchMock.mockResolvedValue(response({}, false, 401));
    expect(await validateProvider(OPENAI)).toEqual({
      ok: false,
      error: expect.stringContaining('401'),
    });
  });

  it('treats a network failure as not-yet-valid (ok:false, no error)', async () => {
    fetchMock.mockRejectedValue(new TypeError('failed to fetch'));
    expect(await validateProvider(OPENAI)).toEqual({ ok: false });
  });
});

describe('provider: listModels', () => {
  it('maps {data:[{id,name}]} to ModelInfo, falling back name->id', async () => {
    fetchMock.mockResolvedValue(
      response({ data: [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'local-model' }] }),
    );
    expect(await listModels(OPENAI)).toEqual([
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'local-model', name: 'local-model' },
    ]);
  });

  it('drops entries without a string id and tolerates a missing data array', async () => {
    fetchMock.mockResolvedValue(response({ data: [{ name: 'no-id' }, { id: 42 }] }));
    expect(await listModels(OPENAI)).toEqual([]);
    fetchMock.mockResolvedValue(response({}));
    expect(await listModels(OPENAI)).toEqual([]);
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(response({}, false, 500));
    await expect(listModels(OPENAI)).rejects.toThrow('500');
  });
});

describe('provider: createProvider', () => {
  it('builds an AI SDK language model for the configured baseURL + model, no network', () => {
    const model = createProvider({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      model: 'anthropic/claude-3.5-sonnet',
    });
    // A v4 language model exposes its modelId; construction must not touch the network.
    expect(model).toBeTypeOf('object');
    expect((model as { modelId?: string }).modelId).toBe('anthropic/claude-3.5-sonnet');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
