// Responsive / device-emulation tools for the agent loop (slice 16) — "see and test the page on
// mobile/tablet/desktop, not just the current viewport". Derived 1:1 from the Zod input consts in
// `src/shared/messages.ts` (the same zero-drift contract the other tool modules hold): the tool NAME
// is the schema's `type` discriminant, the `inputSchema` is that const minus `type`. Three tools
// across two worlds of work:
//   • `setDevice`         — SW-owned: emulate a device (CDP metrics/touch/UA, or a viewport-resize
//                            fallback). Returns the applied metrics + whether the debug banner is up.
//   • `responsiveCapture` — SW-orchestrated: screenshot across breakpoints → an image set the vision
//                            model reads (the loop's `responsiveCaptureToModelOutput` hook fans them
//                            out as labeled image parts).
//   • `checkResponsive`   — content-routed: run the problem scanner at the current width → findings.
//
// Chrome-free + model-free by construction: each `execute` proxies to an injected dispatch (the SW
// runners in `src/agent/device-emulation.ts` + the content transport), so this stays unit-testable.

import { tool } from 'ai';
import type {
  CheckResponsiveInput,
  ResponsiveCaptureInput,
  SetDeviceInput,
  ToolResult,
} from '@/shared/messages';
import {
  CheckResponsiveInput as CheckResponsiveInputSchema,
  ResponsiveCaptureInput as ResponsiveCaptureInputSchema,
  SetDeviceInput as SetDeviceInputSchema,
  ToolResult as ToolResultSchema,
} from '@/shared/messages';

/** Applies device emulation (CDP or fallback) and returns the applied `SetDeviceResult`. */
export type SetDeviceDispatch = (msg: SetDeviceInput, signal?: AbortSignal) => Promise<ToolResult>;

/** Screenshots the page across breakpoints, returning a `ResponsiveCaptureResult` image set. */
export type ResponsiveCaptureDispatch = (
  msg: ResponsiveCaptureInput,
  signal?: AbortSignal,
) => Promise<ToolResult>;

/** Runs the content-world responsive problem scan, returning a `CheckResponsiveResult`. */
export type CheckResponsiveDispatch = (
  msg: CheckResponsiveInput,
  signal?: AbortSignal,
) => Promise<ToolResult>;

export interface ResponsiveToolDeps {
  readonly setDevice: SetDeviceDispatch;
  readonly capture: ResponsiveCaptureDispatch;
  readonly check: CheckResponsiveDispatch;
}

/**
 * Build the responsive `ToolSet` for one turn. Each `execute` reattaches its tool name's `type`
 * discriminant, forwards the model's args (incl. the `Target`) + abort signal, and returns the
 * dispatch's `ToolResult`. Composed alongside the DOM / interaction / vision tools in the loop; the
 * loop attaches `responsiveCaptureToModelOutput` to `responsiveCapture` so its shots come back as
 * images the vision model can actually look at.
 */
export function createResponsiveTools({ setDevice, capture, check }: ResponsiveToolDeps) {
  return {
    setDevice: tool({
      description:
        'Emulate a device so media queries, touch, and UA-sniffing sites respond like the real ' +
        'thing. Pass a `preset` ("iphone-se" | "iphone-15" | "pixel-7" | "ipad-mini" | "desktop") ' +
        'OR a custom `width`+`height` (optional `dpr`/`touch`/`userAgent`); `reset: true` clears ' +
        'emulation. ToolResult.data = { label, mechanism, banner, metrics } — `mechanism: "cdp"` is ' +
        'true device emulation (a "being debugged" banner shows; tell the user), "viewport" is the ' +
        'resize-only fallback. Set a device before measuring or editing for that breakpoint.',
      inputSchema: SetDeviceInputSchema.omit({ type: true }),
      outputSchema: ToolResultSchema,
      execute: (input, { abortSignal }) => setDevice({ type: 'setDevice', ...input }, abortSignal),
    }),
    responsiveCapture: tool({
      description:
        'Screenshot the page across breakpoints (default mobile + tablet + desktop; override with ' +
        '`breakpoints`). `selector` crops one element; `fullPage` scroll-stitches each shot. The ' +
        'images come back to you labeled by breakpoint — inspect them to judge how the design holds ' +
        'up on each. Emulation is restored afterward. Costlier than one screenshot (a capture per ' +
        'breakpoint), so use it when you need to compare across sizes.',
      inputSchema: ResponsiveCaptureInputSchema.omit({ type: true }),
      outputSchema: ToolResultSchema,
      execute: (input, { abortSignal }) =>
        capture({ type: 'responsiveCapture', ...input }, abortSignal),
    }),
    checkResponsive: tool({
      description:
        'Scan for real mobile bugs at the CURRENT (possibly emulated) width: horizontal overflow, ' +
        'sub-44px tap targets, illegible text, clipped content, non-scaling media, a nav that does ' +
        'not collapse, and 100vh / fixed-overlap hazards. `selector` scopes it to a subtree. ' +
        'ToolResult.data = { viewportWidth, findings[] } (most severe first) — cheaper than a ' +
        'screenshot for spotting layout problems. Call `setDevice` first to check a specific device.',
      inputSchema: CheckResponsiveInputSchema.omit({ type: true }),
      outputSchema: ToolResultSchema,
      execute: (input, { abortSignal }) =>
        check({ type: 'checkResponsive', ...input }, abortSignal),
    }),
  };
}
