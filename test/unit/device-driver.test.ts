import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceDriver, type DeviceChrome } from '@/agent/device-driver';
import { DEVICE_PRESETS, restoreDevice } from '@/agent/device-emulation';
import { EmulationRegistry } from '@/agent/emulation-registry';

// #165 S3/S4 unit: emulation OWNERSHIP and the external-detach recovery, against the REAL
// EmulationRegistry (backed by an in-memory chrome.storage.session fake) and a fake browser.
//
// S3 — the owner used to be a module-level `activeEmulationOwner` in background.ts, read inside the
// driver AFTER `chrome.debugger.attach` awaited. A newer turn reassigning it mid-attach made the
// registry stamp the WRONG turn, so the applying turn's teardown skipped (it no longer "owned" the
// tab) and the turn it was misattributed to never emulated anything and restored nothing: the user
// kept a mobile override + the "started debugging this browser" infobar indefinitely.
// S4 — Chrome detaches unilaterally (infobar Cancel, DevTools, target crash). `applyCdp` is
// idempotent against the REGISTRY, so a stale record made it skip the re-attach forever.

// Minimal in-memory chrome.storage.session (MV3 promise API) — same shape as emulation-registry's.
function installChromeStorageSessionFake(): void {
  const store = new Map<string, unknown>();
  const session = {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const names = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (store.has(name)) out[name] = store.get(name);
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [name, value] of Object.entries(items))
        store.set(name, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      return Promise.resolve();
    },
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { session } };
}

/** A fake browser whose `attach` can be held open, so a second turn can run while it is pending. */
function fakeBrowser() {
  const attached = new Set<number>();
  const commands: Array<{ tabId: number; method: string }> = [];
  const windows = new Map<number, { width?: number; height?: number }>([
    [10, { width: 1400, height: 900 }],
  ]);
  const resizes: Array<{ windowId: number; width: number; height: number }> = [];
  let gate: (() => void) | null = null;

  const browser: DeviceChrome = {
    cdpAvailable: () => true,
    attach: async (tabId) => {
      if (gate)
        await new Promise<void>((resolve) => {
          const prior = gate;
          gate = () => {
            prior?.();
            resolve();
          };
        });
      attached.add(tabId);
    },
    detach: async (tabId) => {
      attached.delete(tabId);
    },
    sendCommand: async (tabId, method) => {
      if (!attached.has(tabId)) throw new Error('Debugger is not attached to the tab with id: 1.');
      commands.push({ tabId, method });
    },
    windowIdOf: async () => 10,
    windowBounds: async (windowId) => windows.get(windowId) ?? {},
    resizeWindow: async (windowId, size) => {
      resizes.push({ windowId, ...size });
    },
    restoreWindow: async (saved) => {
      windows.set(saved.windowId, { width: saved.width, height: saved.height });
    },
    defaultUserAgent: () => 'Mozilla/5.0 (Desktop)',
  };
  return {
    browser,
    attached,
    commands,
    resizes,
    windows,
    /** Hold every subsequent `attach` until `release()`. */
    hold: () => {
      gate = () => {};
    },
    release: () => {
      const g = gate;
      gate = null;
      g?.();
    },
  };
}

let emulation: EmulationRegistry;

beforeEach(async () => {
  installChromeStorageSessionFake();
  emulation = new EmulationRegistry();
  await emulation.hydrate();
});

describe('createDeviceDriver ownership (#165 S3)', () => {
  it('stamps the turn that APPLIED the emulation, even when a newer turn starts mid-attach', async () => {
    const world = fakeBrowser();
    const driverA = createDeviceDriver(world.browser, emulation, 'turn-A');

    world.hold();
    const applying = driverA.applyCdp(1, DEVICE_PRESETS['pixel-7']);
    // The user types a new instruction: turn A is aborted and turn B takes over — the exact window
    // in which the old module-level owner was reassigned before A's attach resolved.
    const driverB = createDeviceDriver(world.browser, emulation, 'turn-B');
    expect(driverB).toBeDefined();
    world.release();
    await applying;

    expect(emulation.owns(1, 'turn-A')).toBe(true);
    expect(emulation.owns(1, 'turn-B')).toBe(false);
  });

  it("lets the applying turn's teardown actually restore, instead of skipping as a non-owner", async () => {
    const world = fakeBrowser();
    const driverA = createDeviceDriver(world.browser, emulation, 'turn-A');

    world.hold();
    const applying = driverA.applyCdp(1, DEVICE_PRESETS['iphone-15']);
    createDeviceDriver(world.browser, emulation, 'turn-B');
    world.release();
    await applying;

    // Turn A's `.finally` teardown: `owns()` gates it in background.ts.
    expect(emulation.owns(1, 'turn-A')).toBe(true);
    await restoreDevice(driverA, 1);
    expect(world.attached.has(1)).toBe(false);
    expect(emulation.isAttached(1)).toBe(false);
  });

  it('stamps the viewport-fallback owner from the closure too', async () => {
    const world = fakeBrowser();
    const driver = createDeviceDriver(world.browser, emulation, 'turn-A');
    createDeviceDriver(world.browser, emulation, 'turn-B'); // a concurrent turn exists

    await driver.applyViewport(2, DEVICE_PRESETS['ipad-mini']);

    expect(emulation.owns(2, 'turn-A')).toBe(true);
    expect(emulation.savedWindow(2)).toMatchObject({ windowId: 10, width: 1400, height: 900 });
    expect(world.resizes).toEqual([{ windowId: 10, width: 768, height: 1024 }]);
  });

  it('two concurrent turns on different tabs each own their own tab', async () => {
    const world = fakeBrowser();
    const a = createDeviceDriver(world.browser, emulation, 'turn-A');
    const b = createDeviceDriver(world.browser, emulation, 'turn-B');

    await Promise.all([
      a.applyCdp(1, DEVICE_PRESETS['pixel-7']),
      b.applyCdp(2, DEVICE_PRESETS.desktop),
    ]);

    expect(emulation.owns(1, 'turn-A')).toBe(true);
    expect(emulation.owns(2, 'turn-B')).toBe(true);
  });
});

describe('createDeviceDriver CDP application', () => {
  it('attaches once and applies metrics + touch + UA', async () => {
    const world = fakeBrowser();
    const driver = createDeviceDriver(world.browser, emulation, 'turn-A');

    await driver.applyCdp(1, DEVICE_PRESETS['pixel-7']);
    await driver.applyCdp(1, DEVICE_PRESETS.desktop);

    expect(world.commands.map((c) => c.method)).toEqual([
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Network.setUserAgentOverride',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Network.setUserAgentOverride',
    ]);
    expect(world.attached.has(1)).toBe(true);
  });
});

describe('external detach recovery (#165 S4)', () => {
  it('re-attaches after Chrome detached unilaterally and the onDetach listener cleared the record', async () => {
    const world = fakeBrowser();
    const driver = createDeviceDriver(world.browser, emulation, 'turn-A');
    await driver.applyCdp(1, DEVICE_PRESETS['pixel-7']);

    // The user clicks Cancel on the "started debugging this browser" infobar.
    world.attached.delete(1);
    // background.ts's `chrome.debugger.onDetach` listener — the S4 fix.
    await emulation.clearAttach(1);

    await driver.applyCdp(1, DEVICE_PRESETS['pixel-7']);
    expect(world.attached.has(1)).toBe(true);
  });

  it('WITHOUT that record clear, the next apply skips the re-attach and CDP rejects', async () => {
    const world = fakeBrowser();
    const driver = createDeviceDriver(world.browser, emulation, 'turn-A');
    await driver.applyCdp(1, DEVICE_PRESETS['pixel-7']);

    world.attached.delete(1); // detached behind our back; registry still says attached

    // This is what `applyDevice` swallows before silently dropping to the desktop-UA, DPR-1,
    // no-touch window-resize fallback while the model believes it is looking at a Pixel 7.
    await expect(driver.applyCdp(1, DEVICE_PRESETS['pixel-7'])).rejects.toThrow(/not attached/);
  });

  it('clearCdp is a no-op once the registry says detached', async () => {
    const world = fakeBrowser();
    const detach = vi.spyOn(world.browser, 'detach');
    const driver = createDeviceDriver(world.browser, emulation, 'turn-A');

    await driver.clearCdp(1);
    expect(detach).not.toHaveBeenCalled();
  });
});
