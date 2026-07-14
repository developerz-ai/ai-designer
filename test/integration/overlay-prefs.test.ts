import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverlayCmd, PanelToSw } from '@/shared/messages';
import { OverlayCmd as OverlayCmdSchema, OverlayEnabledResult } from '@/shared/messages';
import { readOverlayEnabled, writeOverlayEnabled } from '@/shared/overlay-prefs';

// Integration — the on-page overlay opt-in seam: panel `set-overlay-enabled`/`get-overlay-enabled`
// -> SW persists via the REAL `@/shared/overlay-prefs.ts` (chrome.storage.local) AND immediately
// pushes an `overlay-toggle` OverlayCmd to the active tab so an already-open page reflects the change
// without a reload. background.ts imports the WXT `#imports` virtual module and can't be imported
// under Vitest, so its `set-overlay-enabled`/`get-overlay-enabled` cases are reproduced 1:1 (the
// in-memory `overlayEnabled` mirror + writeOverlayEnabled + resolveTargetTab + chrome.tabs.sendMessage).
//
// REAL vs faked: real = overlay-prefs read/write, the OverlayCmd + OverlayEnabledResult schemas.
// Faked = chrome.storage.local (Map-backed) + chrome.tabs.query/sendMessage (the cross-world bus).
// Assertions are on real round-tripped persistence + schema-parsed dispatch, not on a mock alone.

function installChromeFakes(opts: { tab?: { id?: number } } = {}): {
  storage: Map<string, unknown>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const storage = new Map<string, unknown>();
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
  const sendMessage = vi.fn(async () => {});
  const query = vi.fn(async () => (opts.tab ? [opts.tab] : []));
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local },
    tabs: { query, sendMessage },
  };
  return { storage, sendMessage };
}

// Rebuilds the SW-lifetime `overlayEnabled` mirror background.ts closes over, plus its two cases.
function makeHandlers() {
  let overlayEnabled = false;

  // Mirrors background.ts's `case 'set-overlay-enabled'`.
  async function handleSet(msg: PanelToSw & { type: 'set-overlay-enabled' }) {
    overlayEnabled = msg.enabled;
    await writeOverlayEnabled(msg.enabled);
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id !== undefined) {
      const cmd: OverlayCmd = { type: 'overlay-toggle', enabled: overlayEnabled };
      await chrome.tabs.sendMessage(tab.id, cmd).catch(() => {});
    }
    return OverlayEnabledResult.parse({ ok: true, enabled: overlayEnabled });
  }

  // Mirrors background.ts's `case 'get-overlay-enabled'`.
  function handleGet() {
    return OverlayEnabledResult.parse({ ok: true, enabled: overlayEnabled });
  }

  return { handleSet, handleGet };
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
});

describe('integration: overlay opt-in persistence + active-tab push', () => {
  it('enabling persists to storage.local and pushes overlay-toggle:true to the active tab', async () => {
    const { storage, sendMessage } = installChromeFakes({ tab: { id: 9 } });
    const { handleSet } = makeHandlers();

    const result = await handleSet({ type: 'set-overlay-enabled', enabled: true });

    expect(result).toEqual({ ok: true, enabled: true });
    // Persisted through the REAL overlay-prefs writer, and readable back through the REAL reader.
    expect(storage.get('overlay:enabled')).toBe(true);
    expect(await readOverlayEnabled()).toBe(true);
    // Pushed to the active tab as a schema-valid OverlayCmd.
    expect(sendMessage).toHaveBeenCalledWith(9, { type: 'overlay-toggle', enabled: true });
    const dispatched = sendMessage.mock.calls[0]?.[1];
    expect(OverlayCmdSchema.safeParse(dispatched).success).toBe(true);
  });

  it('get reflects the last set value without re-reading storage (in-memory mirror)', async () => {
    installChromeFakes({ tab: { id: 9 } });
    const { handleSet, handleGet } = makeHandlers();

    expect(handleGet()).toEqual({ ok: true, enabled: false });
    await handleSet({ type: 'set-overlay-enabled', enabled: true });
    expect(handleGet()).toEqual({ ok: true, enabled: true });
  });

  it('disabling round-trips: overlay-prefs writes false and pushes overlay-toggle:false', async () => {
    const { storage, sendMessage } = installChromeFakes({ tab: { id: 3 } });
    const { handleSet } = makeHandlers();

    await handleSet({ type: 'set-overlay-enabled', enabled: true });
    const off = await handleSet({ type: 'set-overlay-enabled', enabled: false });

    expect(off).toEqual({ ok: true, enabled: false });
    expect(storage.get('overlay:enabled')).toBe(false);
    expect(await readOverlayEnabled()).toBe(false);
    expect(sendMessage).toHaveBeenLastCalledWith(3, { type: 'overlay-toggle', enabled: false });
  });

  it('persists even with no active tab open (the push is skipped, storage still written)', async () => {
    const { storage, sendMessage } = installChromeFakes({ tab: undefined });
    const { handleSet } = makeHandlers();

    const result = await handleSet({ type: 'set-overlay-enabled', enabled: true });

    expect(result).toEqual({ ok: true, enabled: true });
    expect(storage.get('overlay:enabled')).toBe(true);
    expect(await readOverlayEnabled()).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
