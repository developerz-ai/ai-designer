// The owner-bound device-emulation driver (#165 S3). `src/agent/device-emulation.ts` owns the
// DECISION logic (preset resolution, CDP-vs-fallback, sweep, restore); this owns the bookkeeping
// that makes teardown correct — which turn applied an emulation, so a superseded turn tears down
// only its own and never a newer concurrent turn's.
//
// THE BUG THIS REPLACES: the owner used to be a module-level `activeEmulationOwner` in
// background.ts, assigned per turn and READ inside the driver AFTER an await. Turn A (tab 1) calls
// `setDevice`; `chrome.debugger.attach({ tabId: 1 })` is pending; the user types a new instruction,
// which aborts A and reassigns the global to turn B BEFORE A's `runTurn` settles. A's attach
// resolves and records tab 1 as owned by B. A's `.finally` then sees `owns(1, A) === false` and
// skips teardown; B never called `setDevice`, so its teardown restores nothing. The user is left
// with `chrome.debugger` attached, a 393x852 DPR-3 mobile override, and the "started debugging this
// browser" infobar, indefinitely, with no UI to clear it. Two concurrent turns on different tabs
// hit this deterministically rather than by race.
//
// THE FIX: the owner is a CONSTRUCTOR argument, captured in the closure. Each turn builds its own
// driver, so no await can observe another turn's id. Chrome-free by construction (every primitive
// is injected) so the ownership behaviour is unit-testable; `background.ts` binds the real
// `chrome.debugger` / `chrome.windows` calls.

import type { DeviceEmulationDriver, ResolvedDevice } from './device-emulation';
import type { EmulationRegistry, SavedWindow } from './emulation-registry';

/** The raw browser primitives the driver stands on. One method per chrome call it makes. */
export interface DeviceChrome {
  /** True when `chrome.debugger` is usable (the `debugger` permission is declared + granted). */
  cdpAvailable(): boolean;
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  sendCommand(tabId: number, method: string, params: Record<string, unknown>): Promise<void>;
  /** The window the tab lives in; `undefined` for a tab with no window to resize. */
  windowIdOf(tabId: number): Promise<number | undefined>;
  windowBounds(windowId: number): Promise<{ width?: number; height?: number }>;
  resizeWindow(windowId: number, size: { width: number; height: number }): Promise<void>;
  restoreWindow(saved: SavedWindow): Promise<void>;
  /** The browser's own UA, used to CLEAR a mobile override when switching back to desktop. */
  defaultUserAgent(): string;
}

/** The registry slice the driver touches — the real {@link EmulationRegistry} satisfies it. */
export type EmulationBookkeeping = Pick<
  EmulationRegistry,
  'isAttached' | 'savedWindow' | 'recordAttach' | 'recordWindow' | 'clearAttach' | 'clearWindow'
>;

/** The CDP protocol version the SW glue attaches with — here so the constant sits with the driver
 *  contract rather than loose in the entrypoint. */
export const DEBUGGER_PROTOCOL_VERSION = '1.3';

/**
 * Build the emulation driver for ONE turn. `owner` is that turn's id: every attach/resize this
 * driver records is stamped with it, so the turn's teardown (`emulation.owns(tab, owner)`) can tell
 * its own emulation from a newer turn's.
 */
export function createDeviceDriver(
  browser: DeviceChrome,
  emulation: EmulationBookkeeping,
  owner: string,
): DeviceEmulationDriver {
  return {
    cdpAvailable: () => browser.cdpAvailable(),

    applyCdp: async (tabId: number, device: ResolvedDevice) => {
      // Idempotent against the REGISTRY, which is also what makes the `onDetach` listener in
      // background.ts load-bearing (#165 S4): Chrome detaches unilaterally when the user clicks
      // Cancel on the debugger infobar, when DevTools opens, or on a target crash. Without that
      // listener clearing the record, this skips the re-attach, `sendCommand` rejects "Debugger is
      // not attached", and `applyDevice` silently drops to the window-resize fallback — every
      // later breakpoint measured with the desktop UA, DPR 1 and no touch, while the model reports
      // "responsive looks fine" from a desktop rendering it believes is a Pixel 7.
      if (!emulation.isAttached(tabId)) {
        await browser.attach(tabId);
        await emulation.recordAttach(tabId, owner);
      }
      await browser.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
        width: device.width,
        height: device.height,
        deviceScaleFactor: device.dpr,
        mobile: device.mobile,
      });
      await browser.sendCommand(tabId, 'Emulation.setTouchEmulationEnabled', {
        enabled: device.touch,
        maxTouchPoints: device.touch ? 5 : 0,
      });
      // A resolved desktop device carries no UA — override with the browser's own so switching
      // mobile→desktop mid-sweep clears the prior mobile UA (an empty string wouldn't reset it).
      await browser.sendCommand(tabId, 'Network.setUserAgentOverride', {
        userAgent: device.userAgent ?? browser.defaultUserAgent(),
      });
    },

    clearCdp: async (tabId: number) => {
      if (!emulation.isAttached(tabId)) return;
      await emulation.clearAttach(tabId);
      // Detaching drops every override in one call; best-effort (the tab may already be gone).
      await browser.detach(tabId).catch(() => {});
    },

    applyViewport: async (tabId: number, device: ResolvedDevice) => {
      const windowId = await browser.windowIdOf(tabId);
      if (windowId === undefined) throw new Error('The tab has no window to resize.');
      if (!emulation.savedWindow(tabId)) {
        const bounds = await browser.windowBounds(windowId);
        await emulation.recordWindow(tabId, owner, {
          windowId,
          width: bounds.width,
          height: bounds.height,
        });
      }
      await browser.resizeWindow(windowId, { width: device.width, height: device.height });
    },

    clearViewport: async (tabId: number) => {
      const saved = emulation.savedWindow(tabId);
      if (!saved) return;
      await emulation.clearWindow(tabId);
      await browser.restoreWindow(saved).catch(() => {});
    },
  };
}
