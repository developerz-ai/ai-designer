import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BUDGET, DEFAULT_CONTEXT_WINDOW } from '@/agent/budget';
import { listModels, resolveContextWindow } from '@/agent/provider';

// Context-window detection unit: `budget.ts` hardcoded 200k for every model, which is wrong in BOTH
// directions — a fifth of a 1M-context model's capacity, and clean over the wall on a 32k one. The
// window is now read from the provider's own `/models`, tolerantly, and falls back visibly.
//
// Tolerance is the point: there is no standard field for this. OpenRouter uses `context_length`
// (and repeats it under `top_provider`, which is the more accurate figure when a request is
// routed), llama.cpp-style servers use `context_window` or `n_ctx`, and several gateways mirror
// OpenAI and report nothing at all. A gateway that omits it must still list its models.

const endpoint = { baseURL: 'https://example.test/v1', apiKey: 'k' };

function mockModels(data: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ data }) })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listModels: context window', () => {
  it('reads OpenRouter’s `context_length`', async () => {
    mockModels([{ id: 'anthropic/claude', name: 'Claude', context_length: 200_000 }]);
    expect((await listModels(endpoint))[0]?.contextWindow).toBe(200_000);
  });

  it('prefers `top_provider.context_length` — the figure for the provider actually routed to', async () => {
    mockModels([{ id: 'm', context_length: 1_000_000, top_provider: { context_length: 262_144 } }]);
    expect((await listModels(endpoint))[0]?.contextWindow).toBe(262_144);
  });

  it('reads the llama.cpp-style spellings too', async () => {
    mockModels([
      { id: 'a', context_window: 32_768 },
      { id: 'b', n_ctx: 8_192 },
      { id: 'c', max_context_length: 16_384 },
    ]);
    const models = await listModels(endpoint);
    expect(models.map((m) => m.contextWindow)).toEqual([32_768, 8_192, 16_384]);
  });

  it('still lists models when the endpoint reports no window at all', async () => {
    // The OpenAI shape: `/models` is only required to carry `id`. Omitting the window must never
    // cost the user their model list.
    mockModels([{ id: 'gpt-4o' }, { id: 'gpt-4o-mini', name: 'Mini' }]);
    const models = await listModels(endpoint);
    expect(models).toHaveLength(2);
    expect(models[0]?.contextWindow).toBeUndefined();
    expect(models[1]?.name).toBe('Mini');
  });

  it('rejects a garbage window rather than trusting it', async () => {
    // A window of 0 or NaN would make compaction fire forever; a string would compare wrongly.
    mockModels([
      { id: 'z', context_length: 0 },
      { id: 'n', context_length: null },
      { id: 's', context_length: '8192' },
      { id: 'f', context_length: 1.5 },
    ]);
    for (const model of await listModels(endpoint)) {
      expect(model.contextWindow, model.id).toBeUndefined();
    }
  });

  it('survives a malformed catalogue without throwing', async () => {
    mockModels([null, 'nonsense', 42, { noId: true }, { id: 'ok' }]);
    const models = await listModels(endpoint);
    expect(models.map((m) => m.id)).toEqual(['ok']);
  });
});

describe('resolveContextWindow', () => {
  it('finds the selected model’s window', async () => {
    mockModels([
      { id: 'a', context_length: 8_192 },
      { id: 'b', context_length: 128_000 },
    ]);
    expect(await resolveContextWindow(endpoint, 'b')).toBe(128_000);
  });

  it('is undefined for a model the catalogue does not list', async () => {
    mockModels([{ id: 'a', context_length: 8_192 }]);
    expect(await resolveContextWindow(endpoint, 'missing')).toBeUndefined();
  });

  it('never throws — a gateway with no catalogue must stay usable', async () => {
    // It runs on the Save-provider path; a local endpoint with no `/models` is a supported setup.
    mockModels([], false);
    await expect(resolveContextWindow(endpoint, 'm')).resolves.toBeUndefined();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await expect(resolveContextWindow(endpoint, 'm')).resolves.toBeUndefined();
  });
});

describe('the fallback is visible and safe', () => {
  it('DEFAULT_BUDGET carries the fallback window', () => {
    expect(DEFAULT_BUDGET.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('errs low — under-estimating costs a digest, over-estimating loses the turn', () => {
    // 128k is the floor of current mainstream chat models, so an endpoint reporting nothing is
    // unlikely to be below it; a genuinely small local model reports `n_ctx` and is detected.
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128_000);
    expect(DEFAULT_CONTEXT_WINDOW).toBeLessThan(DEFAULT_BUDGET.maxTokens);
  });

  it('keeps the cost-shaped and capacity-shaped ceilings SEPARATE', () => {
    // They answer different questions: `maxTokens` sums input+output across every step (spend),
    // `contextWindow` bounds one request's prompt (capacity). Collapsing them breaks both ways.
    expect(DEFAULT_BUDGET.maxTokens).not.toBe(DEFAULT_BUDGET.contextWindow);
  });
});
