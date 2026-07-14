import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw } from '@/shared/messages';

// Composer's attach trigger / ContextChip's dismiss dispatch onto the focus store's
// startPicker/stopPicker — thin RPC wrappers around start-picker/stop-picker (mirrors the
// chrome-fake pattern in test/unit/settings-store.test.ts).

function installChromeFake(handle: (msg: PanelToSw) => unknown) {
  const sendMessage = vi.fn(async (msg: unknown) => handle(msg as PanelToSw));
  const connect = vi.fn(() => ({
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() },
  }));
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage, connect } };
  return { sendMessage };
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('focus store: startPicker/stopPicker', () => {
  it('startPicker dispatches start-picker', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/focus');

    await store.startPicker();

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'start-picker' }));
  });

  it('stopPicker clears local state immediately and dispatches stop-picker', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/focus');

    store.initFocusStore();
    await store.stopPicker();

    expect(store.selector()).toBeNull();
    expect(store.pickerActive()).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop-picker' }));
  });
});
