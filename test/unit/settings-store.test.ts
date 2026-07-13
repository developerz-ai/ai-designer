import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw } from '@/shared/messages';

// The Save click has to request a not-yet-granted custom host's permission itself —
// chrome.permissions.request only resolves within the SAME live user gesture, and that
// gesture does not survive the hop across chrome.runtime.sendMessage to the service
// worker (see src/shared/host-permissions.ts). This exercises exactly that panel-side
// grant-before-RPC branch in stores/settings.ts, deterministically (no real Chrome
// permission UI — that path is covered by e2e only for an already-granted origin).

type SendMessage = (msg: PanelToSw) => unknown;

function installChromeFake(opts: {
  granted?: string[];
  requestBehavior?: 'grant' | 'deny' | 'reject';
  handle: SendMessage;
}): { request: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> } {
  const held = new Set(opts.granted ?? []);
  const request = vi.fn(async (p: { origins?: string[] }) => {
    if (opts.requestBehavior === 'reject') throw new Error('user gesture required');
    if (opts.requestBehavior === 'grant') {
      for (const o of p.origins ?? []) held.add(o);
      return true;
    }
    return false; // 'deny' (or unset, treated as denied if ever called)
  });
  const contains = vi.fn(async (p: { origins?: string[] }) =>
    (p.origins ?? []).every((o) => held.has(o)),
  );
  const sendMessage = vi.fn(async (msg: unknown) => opts.handle(msg as PanelToSw));
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage },
    permissions: { contains, request },
  };
  return { request, sendMessage };
}

// Minimal SW stand-in: save-provider always reports valid; get-provider echoes back
// whatever was last saved; list-models (hydrate's post-save refresh) returns none.
function defaultHandle(): SendMessage {
  let saved: { baseURL: string; model: string } | null = null;
  return (msg) => {
    switch (msg.type) {
      case 'save-provider':
        saved = { baseURL: msg.config.baseURL, model: msg.config.model };
        return { ok: true, valid: true };
      case 'get-provider':
        return saved
          ? { ok: true, config: { baseURL: saved.baseURL, model: saved.model }, hasKey: true }
          : { ok: true, hasKey: false };
      case 'list-models':
        return { ok: true, models: [] };
      default:
        return { ok: true };
    }
  };
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('settings store: saveProvider requests a custom host grant from the Save click', () => {
  it('skips the permission prompt for an already-granted origin (OpenRouter preset)', async () => {
    vi.resetModules();
    const { request, sendMessage } = installChromeFake({
      granted: ['https://openrouter.ai/*'],
      handle: defaultHandle(),
    });
    const store = await import('@/entrypoints/sidepanel/stores/settings');

    store.selectPreset('openrouter');
    await store.saveProvider('sk-test', 'anthropic/claude-3.5-sonnet');

    expect(request).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'save-provider' }));
    expect(store.settings.saveStatus).toBe('valid');
  });

  it('requests the origin for a not-yet-granted custom host before saving', async () => {
    vi.resetModules();
    const { request, sendMessage } = installChromeFake({
      requestBehavior: 'grant',
      handle: defaultHandle(),
    });
    const store = await import('@/entrypoints/sidepanel/stores/settings');

    store.selectPreset('custom');
    store.setCustomBaseURL('http://localhost:4999/v1');
    await store.saveProvider('sk-test', 'local-model');

    expect(request).toHaveBeenCalledWith({ origins: ['http://localhost/*'] });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'save-provider' }));
    expect(store.settings.saveStatus).toBe('valid');
  });

  it('surfaces a denial without ever sending save-provider (nothing persisted)', async () => {
    vi.resetModules();
    const { request, sendMessage } = installChromeFake({
      requestBehavior: 'deny',
      handle: defaultHandle(),
    });
    const store = await import('@/entrypoints/sidepanel/stores/settings');

    store.selectPreset('custom');
    store.setCustomBaseURL('http://localhost:4999/v1');
    await store.saveProvider('sk-test', 'local-model');

    expect(request).toHaveBeenCalledWith({ origins: ['http://localhost/*'] });
    const sentTypes = sendMessage.mock.calls.map((c) => (c[0] as PanelToSw).type);
    expect(sentTypes).not.toContain('save-provider');
    expect(store.settings.saveStatus).toBe('invalid');
    expect(store.settings.error).toContain('http://localhost/*');
  });

  it('surfaces a request rejection (called outside a live user gesture) the same way', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake({
      requestBehavior: 'reject',
      handle: defaultHandle(),
    });
    const store = await import('@/entrypoints/sidepanel/stores/settings');

    store.selectPreset('custom');
    store.setCustomBaseURL('http://localhost:4999/v1');
    await store.saveProvider('sk-test', 'local-model');

    const sentTypes = sendMessage.mock.calls.map((c) => (c[0] as PanelToSw).type);
    expect(sentTypes).not.toContain('save-provider');
    expect(store.settings.saveStatus).toBe('invalid');
    expect(store.settings.error).toContain('Could not request host access');
  });
});
