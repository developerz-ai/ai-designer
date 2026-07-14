import { describe, expect, it } from 'vitest';
import {
  type CaptureAt,
  DEFAULT_BREAKPOINTS,
  DEVICE_PRESETS,
  type DeviceEmulationDriver,
  resolveDevice,
  restoreDevice,
  runResponsiveCapture,
  runSetDevice,
  toDeviceMetrics,
} from '@/agent/device-emulation';
import type {
  ResponsiveCaptureInput,
  ResponsiveCaptureResult,
  SetDeviceInput,
  SetDeviceResult,
} from '@/shared/messages';

// device-emulation unit: the SW-orchestration runners (setDevice / responsiveCapture) behind an
// injected driver — no chrome, no debugger. We record driver calls and assert the runner resolves
// presets, prefers CDP but falls back to the viewport path (or on a CDP throw), restores emulation
// after a sweep, and degrades a bad spec / failed grab to an error the agent reads.

type Call = [string, ...unknown[]];

function harness(opts: { cdp?: boolean; over?: Partial<DeviceEmulationDriver> } = {}) {
  const calls: Call[] = [];
  const driver: DeviceEmulationDriver = {
    cdpAvailable: () => opts.cdp ?? true,
    applyCdp: async (tabId, device) => {
      calls.push(['applyCdp', tabId, device.label]);
    },
    clearCdp: async (tabId) => {
      calls.push(['clearCdp', tabId]);
    },
    applyViewport: async (tabId, device) => {
      calls.push(['applyViewport', tabId, device.label]);
    },
    clearViewport: async (tabId) => {
      calls.push(['clearViewport', tabId]);
    },
    ...opts.over,
  };
  return { calls, driver };
}

// A capture that echoes what it was asked to grab, so a shot's `image` is inspectable.
const okCapture: CaptureAt = async (tabId, o) => ({
  type: 'tool-result',
  ok: true,
  data: `png:${tabId}:${o.selector ?? 'viewport'}`,
});
const settle = async (): Promise<void> => {};

function names(calls: Call[]): string[] {
  return calls.map((c) => c[0]);
}
const setDeviceInput = (over: Partial<SetDeviceInput> = {}): SetDeviceInput => ({
  type: 'setDevice',
  ...over,
});
const captureInput = (over: Partial<ResponsiveCaptureInput> = {}): ResponsiveCaptureInput => ({
  type: 'responsiveCapture',
  ...over,
});

describe('resolveDevice', () => {
  it('expands a preset to concrete metrics', () => {
    const d = resolveDevice({ preset: 'iphone-15' });
    expect(d).toMatchObject({ label: 'iPhone 15', width: 393, dpr: 3, touch: true, mobile: true });
    expect(d?.userAgent).toContain('iPhone');
  });

  it('lets custom fields override a preset', () => {
    const d = resolveDevice({ preset: 'desktop', width: 1440, touch: true });
    expect(d).toMatchObject({ width: 1440, touch: true, mobile: false });
  });

  it('accepts a bare width+height and infers touch/mobile from width', () => {
    expect(resolveDevice({ width: 400, height: 800 })).toMatchObject({ touch: true, mobile: true });
    expect(resolveDevice({ width: 1200, height: 800 })).toMatchObject({
      touch: false,
      mobile: false,
      label: '1200×800',
    });
  });

  it('clamps absurd custom dimensions and returns null for an underspecified spec', () => {
    expect(resolveDevice({ width: 999999, height: 800 })?.width).toBe(5000);
    expect(resolveDevice({})).toBeNull();
    expect(resolveDevice({ width: 500 })).toBeNull(); // height missing
  });

  it('every preset resolves and drops its label for the bus metrics', () => {
    for (const preset of Object.keys(DEVICE_PRESETS)) {
      const d = resolveDevice({ preset: preset as keyof typeof DEVICE_PRESETS });
      expect(d).not.toBeNull();
      expect(toDeviceMetrics(d as NonNullable<typeof d>)).not.toHaveProperty('label');
    }
  });
});

describe('runSetDevice', () => {
  it('applies via CDP when available and reports the banner + metrics', async () => {
    const { calls, driver } = harness({ cdp: true });
    const r = await runSetDevice(driver, setDeviceInput({ preset: 'iphone-15' }), 7);
    expect(r.ok).toBe(true);
    const data = r.data as SetDeviceResult;
    expect(data).toMatchObject({ label: 'iPhone 15', mechanism: 'cdp', banner: true });
    expect(data.metrics?.width).toBe(393);
    expect(names(calls)).toEqual(['applyCdp']);
    expect(calls[0]?.[1]).toBe(7); // default tabId used
  });

  it('falls back to the viewport path when CDP is unavailable', async () => {
    const { calls, driver } = harness({ cdp: false });
    const r = await runSetDevice(driver, setDeviceInput({ preset: 'pixel-7', tabId: 3 }), 7);
    const data = r.data as SetDeviceResult;
    expect(data).toMatchObject({ mechanism: 'viewport', banner: false });
    expect(names(calls)).toEqual(['applyViewport']);
    expect(calls[0]?.[1]).toBe(3); // explicit tabId wins
  });

  it('falls back to the viewport path when a CDP attach throws', async () => {
    const { calls, driver } = harness({
      cdp: true,
      over: {
        applyCdp: async () => {
          throw new Error('debugger declined');
        },
      },
    });
    const r = await runSetDevice(driver, setDeviceInput({ preset: 'ipad-mini' }), 1);
    expect((r.data as SetDeviceResult).mechanism).toBe('viewport');
    expect(names(calls)).toEqual(['applyViewport']);
  });

  it('reset clears both paths and carries no metrics', async () => {
    const { calls, driver } = harness();
    const r = await runSetDevice(driver, setDeviceInput({ reset: true }), 1);
    expect(r.ok).toBe(true);
    expect(r.data as SetDeviceResult).toMatchObject({ mechanism: 'reset', banner: false });
    expect((r.data as SetDeviceResult).metrics).toBeUndefined();
    expect(names(calls)).toEqual(['clearCdp', 'clearViewport']);
  });

  it('errors (never throws) on an underspecified spec', async () => {
    const { driver } = harness();
    const r = await runSetDevice(driver, setDeviceInput(), 1);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('preset');
  });
});

describe('runResponsiveCapture', () => {
  it('sweeps the default breakpoints, captures each, and restores emulation after', async () => {
    const { calls, driver } = harness({ cdp: true });
    const r = await runResponsiveCapture(driver, okCapture, settle, captureInput(), 9);
    const data = r.data as ResponsiveCaptureResult;
    expect(data.shots.map((s) => s.label)).toEqual(['Mobile', 'Tablet', 'Desktop']);
    expect(data.shots.every((s) => s.image?.startsWith('png:9:'))).toBe(true);
    // apply per breakpoint, then a single restore (clearCdp + clearViewport) at the end.
    expect(names(calls)).toEqual(['applyCdp', 'applyCdp', 'applyCdp', 'clearCdp', 'clearViewport']);
    expect(data.shots).toHaveLength(DEFAULT_BREAKPOINTS.length);
  });

  it('turns a failed grab into that shot’s error without aborting the sweep', async () => {
    const { driver } = harness();
    const flaky: CaptureAt = async (_t, o) =>
      o.selector === undefined
        ? { type: 'tool-result', ok: false, error: 'quota' }
        : { type: 'tool-result', ok: true, data: 'png' };
    const r = await runResponsiveCapture(
      driver,
      flaky,
      settle,
      captureInput({ breakpoints: [{ preset: 'iphone-15' }, { preset: 'desktop' }] }),
      1,
    );
    const shots = (r.data as ResponsiveCaptureResult).shots;
    expect(shots).toHaveLength(2);
    expect(shots.every((s) => s.error === 'quota')).toBe(true);
  });

  it('flags an invalid breakpoint but still restores', async () => {
    const { calls, driver } = harness();
    const r = await runResponsiveCapture(
      driver,
      okCapture,
      settle,
      captureInput({ breakpoints: [{ label: 'bad' }] }),
      1,
    );
    const shots = (r.data as ResponsiveCaptureResult).shots;
    expect(shots[0]?.error).toContain('preset');
    expect(names(calls)).toContain('clearCdp'); // restore still ran
  });
});

describe('restoreDevice', () => {
  it('clears both paths and swallows a driver rejection', async () => {
    const { calls, driver } = harness({
      over: {
        clearCdp: async () => {
          throw new Error('gone');
        },
      },
    });
    await expect(restoreDevice(driver, 5)).resolves.toBeUndefined();
    expect(names(calls)).toContain('clearViewport');
  });
});
