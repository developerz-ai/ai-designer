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

  it.each([
    'startPicker',
    'stopPicker',
  ] as const)('%s surfaces a rejected RPC instead of rejecting into an unhandled rejection', async (action) => {
    // The SW is mid-restart: chrome answers "Receiving end does not exist". Unhandled, the
    // button silently does nothing and Sentry logs a crash.
    vi.resetModules();
    installChromeFake(() => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });
    const store = await import('@/entrypoints/sidepanel/stores/focus');

    await expect(store[action]()).resolves.toBeUndefined();
    expect(store.error()).toMatch(/Receiving end does not exist/);
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
