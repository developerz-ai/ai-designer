import { describe, expect, it } from 'vitest';
import {
  type CaptureAt,
  type DeviceEmulationDriver,
  runResponsiveCapture,
  runSetDevice,
} from '@/agent/device-emulation';
import { responsiveCaptureToModelOutput } from '@/agent/loop';
import { createResponsiveTools } from '@/agent/tools/responsive';
import type { ResponsiveProbe } from '@/dom/responsive';
import { scanResponsive } from '@/dom/responsive';
import type {
  CheckResponsiveResult,
  ResponsiveCaptureResult,
  SetDeviceResult,
  ToolResult,
} from '@/shared/messages';

// Integration: the responsive AI-SDK tools (src/agent/tools/responsive.ts) wired to the REAL SW
// runners (src/agent/device-emulation.ts) behind a fake driver + fake capture, and to the REAL
// content scanner (src/dom/responsive.ts) over a jsdom document. Proves the three compose end to end:
// `setDevice` resolves a preset and drives emulation; `responsiveCapture` sweeps breakpoints into an
// image set the vision hook fans out; `checkResponsive` surfaces a real overflow finding.

function callExecute(execute: unknown, input: Record<string, unknown>) {
  if (typeof execute !== 'function') throw new Error('tool is missing an execute function');
  const signal = new AbortController().signal;
  return (execute as (i: unknown, o: { abortSignal?: AbortSignal }) => Promise<ToolResult>)(input, {
    abortSignal: signal,
  });
}

type Call = [string, ...unknown[]];

function fakeDriver(cdp: boolean) {
  const calls: Call[] = [];
  const driver: DeviceEmulationDriver = {
    cdpAvailable: () => cdp,
    applyCdp: async (t, d) => {
      calls.push(['applyCdp', t, d.width]);
    },
    clearCdp: async (t) => {
      calls.push(['clearCdp', t]);
    },
    applyViewport: async (t, d) => {
      calls.push(['applyViewport', t, d.width]);
    },
    clearViewport: async (t) => {
      calls.push(['clearViewport', t]);
    },
  };
  return { calls, driver };
}

const settle = async (): Promise<void> => {};
const capture: CaptureAt = async () => ({
  type: 'tool-result',
  ok: true,
  data: 'data:image/png;base64,PNGDATA',
});

// A probe that reports a page wider than the viewport, so `scanResponsive` yields exactly the
// page-level overflow finding (jsdom has no layout, so all element rects read 0 → those scans skip).
const overflowProbe: ResponsiveProbe = {
  viewportWidth: () => 375,
  viewportHeight: () => 700,
  rect: () => ({ width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 }),
  scrollWidth: (el) => (el === document.documentElement ? 900 : 0),
  clientWidth: (el) => (el === document.documentElement ? 375 : 0),
  scrollHeight: () => 0,
  clientHeight: () => 0,
  computed: () => '',
  intrinsicWidth: () => 0,
};

function buildTools(cdp: boolean) {
  const { calls, driver } = fakeDriver(cdp);
  const tools = createResponsiveTools({
    setDevice: (msg) => runSetDevice(driver, msg, 42),
    capture: (msg, signal) => runResponsiveCapture(driver, capture, settle, msg, 42, signal),
    check: async (msg) => {
      const root = (msg.selector ? document.querySelector(msg.selector) : document) ?? document;
      const data = scanResponsive(document, window, { root, probe: overflowProbe });
      return { type: 'tool-result', ok: true, data };
    },
  });
  return { calls, tools };
}

describe('responsive tools → real runners + scanner', () => {
  it('setDevice resolves a preset and drives CDP emulation', async () => {
    const { calls, tools } = buildTools(true);
    const r = await callExecute(tools.setDevice.execute, { preset: 'iphone-15' });
    expect((r.data as SetDeviceResult).mechanism).toBe('cdp');
    expect((r.data as SetDeviceResult).metrics?.width).toBe(393);
    expect(calls).toEqual([['applyCdp', 42, 393]]);
  });

  it('setDevice degrades to the viewport fallback with no debugger', async () => {
    const { calls, tools } = buildTools(false);
    const r = await callExecute(tools.setDevice.execute, { preset: 'pixel-7' });
    expect((r.data as SetDeviceResult).mechanism).toBe('viewport');
    expect(calls[0]?.[0]).toBe('applyViewport');
  });

  it('responsiveCapture sweeps default breakpoints into a fanned-out image set', async () => {
    const { tools } = buildTools(true);
    const r = await callExecute(tools.responsiveCapture.execute, {});
    const shots = (r.data as ResponsiveCaptureResult).shots;
    expect(shots.map((s) => s.label)).toEqual(['Mobile', 'Tablet', 'Desktop']);

    const out = responsiveCaptureToModelOutput({ output: r });
    if (out.type !== 'content') throw new Error('expected an image content output');
    // Three captions + three PNG file parts, interleaved.
    expect(out.value.filter((p) => p.type === 'file')).toHaveLength(3);
    expect(out.value[0]).toMatchObject({ type: 'text', text: 'Mobile (393×852, cdp)' });
  });

  it('checkResponsive surfaces the page overflow finding at the emulated width', async () => {
    const { tools } = buildTools(true);
    const r = await callExecute(tools.checkResponsive.execute, {});
    const data = r.data as CheckResponsiveResult;
    expect(data.viewportWidth).toBe(375);
    expect(data.findings.some((f) => f.category === 'overflow' && f.severity === 'serious')).toBe(
      true,
    );
  });
});
