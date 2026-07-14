// Device emulation orchestration — the service worker's "see the page as a phone/tablet" half
// (slice 16). Real mobile emulation is more than a width change: media queries, `@media (pointer)`,
// and UA-sniffing sites only respond correctly with the right DPR, touch, and mobile UA. So the
// preferred path drives `chrome.debugger` + CDP (`Emulation.setDeviceMetricsOverride` /
// `setTouchEmulationEnabled` / `Network.setUserAgentOverride`); when the `debugger` permission is
// declined or attach fails, it degrades to a viewport-resize fallback that approximates layout but
// not UA/touch (docs/plans .../16-responsive-mobile.md "Emulation mechanism").
//
// Chrome-free + testable by construction, exactly like `src/agent/browser-control.ts`: the pure
// decision logic (preset resolution, CDP-vs-fallback pick, per-breakpoint sweep, restore) lives here
// behind an injected `DeviceEmulationDriver`; the real `chrome.debugger`/`chrome.windows` glue is in
// `src/entrypoints/background.ts` (coverage-excluded). Every driver rejection degrades to an error
// ToolResult the agent reacts to — never a throw that kills the turn.

import type {
  Breakpoint,
  DeviceMetrics,
  DevicePreset,
  EmulationMechanism,
  ResponsiveCaptureInput,
  ResponsiveCaptureResult,
  ResponsiveShot,
  SetDeviceInput,
  SetDeviceResult,
  ToolResult,
} from '@/shared/messages';

// --- presets --------------------------------------------------------------

/** A preset or custom spec expanded to concrete emulation metrics + its display label. */
export interface ResolvedDevice extends DeviceMetrics {
  readonly label: string;
}

// The subset of `SetDeviceInput` / `Breakpoint` `resolveDevice` reads — both satisfy it structurally,
// so one resolver serves `setDevice` and every `responsiveCapture` breakpoint (no drift).
export interface DeviceSpec {
  preset?: DevicePreset;
  label?: string;
  width?: number;
  height?: number;
  dpr?: number;
  touch?: boolean;
  userAgent?: string;
}

// Realistic device UAs so UA-sniffing sites serve their mobile paths under CDP `setUserAgentOverride`.
const UA_IOS_PHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

/** Named presets → CSS-px metrics. Sizes/DPRs match the real devices so breakpoints land where a
 *  user's phone/tablet does. `desktop` is a plain large viewport (no touch, no UA override). */
export const DEVICE_PRESETS: Record<DevicePreset, ResolvedDevice> = {
  'iphone-se': {
    label: 'iPhone SE',
    width: 375,
    height: 667,
    dpr: 2,
    touch: true,
    mobile: true,
    userAgent: UA_IOS_PHONE,
  },
  'iphone-15': {
    label: 'iPhone 15',
    width: 393,
    height: 852,
    dpr: 3,
    touch: true,
    mobile: true,
    userAgent: UA_IOS_PHONE,
  },
  'pixel-7': {
    label: 'Pixel 7',
    width: 412,
    height: 915,
    dpr: 2.625,
    touch: true,
    mobile: true,
    userAgent: UA_ANDROID,
  },
  'ipad-mini': {
    label: 'iPad mini',
    width: 768,
    height: 1024,
    dpr: 2,
    touch: true,
    mobile: true,
    userAgent: UA_IPAD,
  },
  desktop: {
    label: 'Desktop',
    width: 1280,
    height: 800,
    dpr: 1,
    touch: false,
    mobile: false,
  },
};

/** The default `responsiveCapture` sweep when the agent names no breakpoints: phone, tablet, desktop. */
export const DEFAULT_BREAKPOINTS: readonly Breakpoint[] = [
  { preset: 'iphone-15', label: 'Mobile' },
  { preset: 'ipad-mini', label: 'Tablet' },
  { preset: 'desktop', label: 'Desktop' },
];

const MAX_DIM = 5000; // matches the schema bound; hard-caps a hostile custom spec
const MAX_DPR = 5;
const TOUCH_MAX_WIDTH = 768; // a custom spec at/below this defaults to touch + mobile

const clampDim = (n: number): number => Math.min(MAX_DIM, Math.max(1, Math.round(n)));
const clampDpr = (n: number): number => Math.min(MAX_DPR, Math.max(0.1, n));

/**
 * Resolve a spec to concrete metrics: a `preset` (with any custom field overriding it), or a bare
 * `width`×`height` (dpr defaults 1; touch/mobile inferred from width). Returns `null` when neither a
 * preset nor a full `width`+`height` is given — the caller surfaces that as an error ToolResult.
 */
export function resolveDevice(spec: DeviceSpec): ResolvedDevice | null {
  if (spec.preset) {
    const base = DEVICE_PRESETS[spec.preset];
    const userAgent = spec.userAgent ?? base.userAgent;
    return {
      label: spec.label ?? base.label,
      width: clampDim(spec.width ?? base.width),
      height: clampDim(spec.height ?? base.height),
      dpr: clampDpr(spec.dpr ?? base.dpr),
      touch: spec.touch ?? base.touch,
      mobile: base.mobile,
      ...(userAgent ? { userAgent } : {}),
    };
  }
  if (spec.width && spec.height) {
    const width = clampDim(spec.width);
    const touch = spec.touch ?? width <= TOUCH_MAX_WIDTH;
    return {
      label: spec.label ?? `${width}×${clampDim(spec.height)}`,
      width,
      height: clampDim(spec.height),
      dpr: clampDpr(spec.dpr ?? 1),
      touch,
      mobile: touch,
      ...(spec.userAgent ? { userAgent: spec.userAgent } : {}),
    };
  }
  return null;
}

/** The bus `DeviceMetrics` for a resolved device (drops the label). */
export function toDeviceMetrics(device: ResolvedDevice): DeviceMetrics {
  const { label: _label, ...metrics } = device;
  return metrics;
}

// --- driver ---------------------------------------------------------------

/** The SW-side primitives the emulation runners stand on, injected so this module is chrome-free and
 *  testable. Implemented against `chrome.debugger` / `chrome.windows` in `background.ts`. */
export interface DeviceEmulationDriver {
  /** True when `chrome.debugger` is usable (the `debugger` permission is declared + granted). */
  cdpAvailable(): boolean;
  /** Attach the debugger to the tab (idempotent) and apply device metrics + touch + UA via CDP.
   *  Rejects if attach/override fails — the runner then falls back to the viewport path. */
  applyCdp(tabId: number, device: ResolvedDevice): Promise<void>;
  /** Detach + clear every CDP override for the tab (idempotent; a no-op if not attached). */
  clearCdp(tabId: number): Promise<void>;
  /** Fallback: approximate the device by resizing the tab's window (no UA/touch). */
  applyViewport(tabId: number, device: ResolvedDevice): Promise<void>;
  /** Fallback restore: return the window to its pre-emulation bounds (idempotent). */
  clearViewport(tabId: number): Promise<void>;
}

const ok = (data: unknown): ToolResult => ({ type: 'tool-result', ok: true, data });
const fail = (error: string): ToolResult => ({ type: 'tool-result', ok: false, error });

// Apply one device the best way available: CDP if usable, else the viewport fallback. A CDP failure
// (permission just revoked, target not attachable) silently degrades to the fallback so the agent
// still gets an approximate layout instead of an error.
async function applyDevice(
  driver: DeviceEmulationDriver,
  tabId: number,
  device: ResolvedDevice,
): Promise<{ mechanism: EmulationMechanism; banner: boolean }> {
  if (driver.cdpAvailable()) {
    try {
      await driver.applyCdp(tabId, device);
      return { mechanism: 'cdp', banner: true };
    } catch {
      // Attach/override failed — fall through to the resize fallback rather than failing the tool.
    }
  }
  await driver.applyViewport(tabId, device);
  return { mechanism: 'viewport', banner: false };
}

/** Clear emulation on a tab through both paths (best-effort). Called by `setDevice reset`, after a
 *  `responsiveCapture` sweep, and by the SW on turn end so no debugger stays attached / window stays
 *  resized past the turn. Safe to call when nothing was applied. */
export async function restoreDevice(driver: DeviceEmulationDriver, tabId: number): Promise<void> {
  await driver.clearCdp(tabId).catch(() => {});
  await driver.clearViewport(tabId).catch(() => {});
}

// --- setDevice ------------------------------------------------------------

/**
 * Apply `setDevice`: `reset` clears emulation; otherwise resolve the preset/custom spec and apply it
 * (CDP or fallback). Returns a `SetDeviceResult` the agent reads — including `banner` so it can warn
 * the user the "being debugged" bar is up. A driver rejection degrades to an error ToolResult.
 */
export async function runSetDevice(
  driver: DeviceEmulationDriver,
  input: SetDeviceInput,
  defaultTabId: number,
): Promise<ToolResult> {
  const tabId = input.tabId ?? defaultTabId;
  if (input.reset) {
    await restoreDevice(driver, tabId);
    return ok({ label: 'Reset', mechanism: 'reset', banner: false } satisfies SetDeviceResult);
  }
  const device = resolveDevice(input);
  if (!device) {
    return fail('`setDevice` needs a `preset`, or a `width` and `height` (or `reset: true`).');
  }
  try {
    const { mechanism, banner } = await applyDevice(driver, tabId, device);
    return ok({
      label: device.label,
      mechanism,
      banner,
      metrics: toDeviceMetrics(device),
    } satisfies SetDeviceResult);
  } catch (err) {
    return fail(String(err));
  }
}

// --- responsiveCapture ----------------------------------------------------

/** Screenshot one breakpoint the way `responsiveCapture` asks — element crop, viewport, or full page. */
export type CaptureAt = (
  tabId: number,
  opts: { selector?: string; fullPage?: boolean },
  signal?: AbortSignal,
) => Promise<ToolResult>;

/** Let the page reflow/paint after an emulation change before the grab (injected so it's chrome-free
 *  here; the SW passes an abortable delay). */
export type SettleFn = (signal?: AbortSignal) => Promise<void>;

/**
 * Sweep `breakpoints` (default phone/tablet/desktop): apply each device, let it settle, capture it,
 * and collect a labeled shot — one failed grab becomes that shot's `error`, never an aborted sweep.
 * Emulation is always restored afterward (a `finally`), so the user's page is left as it was found.
 */
export async function runResponsiveCapture(
  driver: DeviceEmulationDriver,
  capture: CaptureAt,
  settle: SettleFn,
  input: ResponsiveCaptureInput,
  defaultTabId: number,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const tabId = input.tabId ?? defaultTabId;
  const breakpoints = input.breakpoints?.length ? input.breakpoints : DEFAULT_BREAKPOINTS;
  const shots: ResponsiveShot[] = [];
  try {
    for (const bp of breakpoints) {
      if (signal?.aborted) break;
      const device = resolveDevice(bp);
      if (!device) {
        shots.push({
          label: bp.label ?? 'custom',
          metrics: toDeviceMetrics(DEVICE_PRESETS.desktop),
          mechanism: 'viewport',
          error: 'Breakpoint needs a `preset` or a `width`+`height`.',
        });
        continue;
      }
      const { mechanism } = await applyDevice(driver, tabId, device);
      await settle(signal);
      const shot = await capture(
        tabId,
        { selector: input.selector, fullPage: input.fullPage },
        signal,
      );
      shots.push({
        label: device.label,
        metrics: toDeviceMetrics(device),
        mechanism,
        ...(shot.ok && typeof shot.data === 'string'
          ? { image: shot.data }
          : { error: (shot.error ?? 'Capture failed').slice(0, 300) }),
      });
    }
  } finally {
    await restoreDevice(driver, tabId);
  }
  return ok({ shots } satisfies ResponsiveCaptureResult);
}
