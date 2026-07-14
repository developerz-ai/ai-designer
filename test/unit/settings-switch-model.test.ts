import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw } from '@/shared/messages';

// Composer's inline model quick-switch (`switchModel`) — a lighter dispatch than the full
// saveProvider form flow this file's sibling (settings-store.test.ts) covers.

function installChromeFake(handle: (msg: PanelToSw) => unknown) {
  const sendMessage = vi.fn(async (msg: unknown) => handle(msg as PanelToSw));
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
  return { sendMessage };
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('settings store: switchModel', () => {
  it('optimistically sets the model and persists via set-model', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/settings');

    await store.switchModel('anthropic/claude-3.5-sonnet');

    expect(store.settings.model).toBe('anthropic/claude-3.5-sonnet');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set-model', model: 'anthropic/claude-3.5-sonnet' }),
    );
  });

  it('reverts the model and surfaces an error when the RPC rejects', async () => {
    vi.resetModules();
    installChromeFake(() => {
      throw new Error('offline');
    });
    const store = await import('@/entrypoints/sidepanel/stores/settings');

    const before = store.settings.model;
    await store.switchModel('some/model');

    expect(store.settings.model).toBe(before);
    expect(store.settings.error).toContain('offline');
  });
});
