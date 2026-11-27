import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw } from '@/shared/messages';

// Settings actions vs. the replies they get. `{ ok: false }` satisfies `OkResult`, so a refused
// set-model / clear used to read as success; and Save's post-save refresh (hydrate → loadModels)
// overwrote the save's specific error with null or a generic list failure.

function installChromeFake(handle: (msg: PanelToSw) => unknown): void {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage: vi.fn(async (msg: unknown) => handle(msg as PanelToSw)) },
    // OpenRouter's origin is already held, so Save never prompts.
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

const SAVED = {
  ok: true,
  config: { baseURL: 'https://openrouter.ai/api/v1', model: 'old/model' },
  hasKey: true,
};

describe('saveProvider keeps its own error through the post-save refresh', () => {
  it('does not let a successful model refresh clear the save error', async () => {
    installChromeFake((msg) => {
      if (msg.type === 'save-provider') return { ok: true, valid: false, error: 'Key rejected' };
      if (msg.type === 'get-provider') return SAVED;
      if (msg.type === 'list-models') return { ok: true, models: [{ id: 'a', name: 'A' }] };
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/settings');

    await store.saveProvider('sk-bad', 'old/model');

    expect(store.settings.saveStatus).toBe('invalid');
    expect(store.settings.error).toBe('Key rejected');
  });

  it('does not let a failed model refresh replace the save error', async () => {
    installChromeFake((msg) => {
      if (msg.type === 'save-provider') return { ok: true, valid: false, error: 'Key rejected' };
      if (msg.type === 'get-provider') return SAVED;
      if (msg.type === 'list-models') return { ok: false, error: 'list failed' };
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/settings');

    await store.saveProvider('sk-bad', 'old/model');

    expect(store.settings.error).toBe('Key rejected');
  });

  it('a plain refresh still reports its own failure', async () => {
    installChromeFake((msg) =>
      msg.type === 'list-models' ? { ok: false, error: 'list failed' } : { ok: true },
    );
    const store = await import('@/entrypoints/sidepanel/stores/settings');

    await store.loadModels('sk-typed');

    expect(store.settings.error).toBe('list failed');
  });
});

describe('switchModel / clearProvider check ok', () => {
  it('rolls the optimistic model back on { ok: false }', async () => {
    installChromeFake((msg) => {
      if (msg.type === 'get-provider') return SAVED;
      if (msg.type === 'list-models') return { ok: true, models: [] };
      if (msg.type === 'set-model') return { ok: false, error: 'storage full' };
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/settings');
    await store.hydrate();
    expect(store.settings.model).toBe('old/model');

    await store.switchModel('new/model');

    expect(store.settings.model).toBe('old/model');
    expect(store.settings.error).toBe('storage full');
  });

  it('keeps the "key stored" state when the clear is refused', async () => {
    installChromeFake((msg) => {
      if (msg.type === 'get-provider') return SAVED;
      if (msg.type === 'list-models') return { ok: true, models: [] };
      if (msg.type === 'clear-openrouter-key') return { ok: false };
      return { ok: true };
    });
    const store = await import('@/entrypoints/sidepanel/stores/settings');
    await store.hydrate();

    await store.clearProvider();

    expect(store.settings.hasKey).toBe(true);
    expect(store.settings.model).toBe('old/model');
    expect(store.settings.error).toBeTruthy();
  });
});
