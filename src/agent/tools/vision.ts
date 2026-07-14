// Vision / image tools for the agent loop (slice 13) — "see what's on screen and verify it".
// Derived 1:1 from the Zod input consts in `src/shared/messages.ts` (the same zero-drift contract
// the other tool modules hold). Three tools, three worlds of work:
//   • `screenshot`   — SW-orchestrated: element/viewport crop routes to content, `fullPage` scroll-
//                       stitches viewport grabs in the SW. Returns a PNG the (vision) model can see.
//   • `readImages`   — content-routed: enumerate <img> + CSS backgrounds, flag broken / oversized.
//   • `inspectVisually` — SW-only: screenshot the region, ask the vision model a question, return
//                       its verdict for self-correction (one extra model round-trip, on demand).
//
// Chrome-free + model-free by construction: each `execute` proxies to an injected dispatch, so this
// stays unit-testable. The loop attaches the screenshot→image vision hook (`screenshotToModelOutput`)
// so a returned PNG is fed back to the model as an image part, not JSON.

import { tool } from 'ai';
import type { InspectVisuallyInput, ReadImagesInput, ScreenshotInput } from '@/shared/messages';
import {
  InspectVisuallyInput as InspectVisuallyInputSchema,
  ReadImagesInput as ReadImagesInputSchema,
  ScreenshotInput as ScreenshotInputSchema,
  ToolResult,
} from '@/shared/messages';

/** Captures a PNG of the target: element/viewport crop, or the whole scrollable page (`fullPage`). */
export type ScreenshotDispatch = (
  msg: ScreenshotInput,
  signal?: AbortSignal,
) => Promise<ToolResult>;

/** Enumerates images in the target frame (content-routed). */
export type ReadImagesDispatch = (
  msg: ReadImagesInput,
  signal?: AbortSignal,
) => Promise<ToolResult>;

/** Captures the region + asks the vision model a question about it, returning its verdict. */
export type InspectDispatch = (
  msg: InspectVisuallyInput,
  signal?: AbortSignal,
) => Promise<ToolResult>;

export interface VisionToolDeps {
  readonly screenshot: ScreenshotDispatch;
  readonly readImages: ReadImagesDispatch;
  readonly inspect: InspectDispatch;
}

/**
 * Build the vision `ToolSet` for one turn. Each `execute` reattaches its tool name's `type`
 * discriminant, forwards the model's args (incl. the `Target`), and returns the dispatch's
 * `ToolResult`. Composed alongside the DOM, interaction, tabs, session, and MCP tools in the loop.
 */
export function createVisionTools({ screenshot, readImages, inspect }: VisionToolDeps) {
  return {
    screenshot: tool({
      description:
        'Capture a PNG: the element matching `selector`, the current viewport (omit `selector`), or ' +
        'the whole scrollable page (`fullPage: true`, scroll-stitched). ToolResult.data = a base64 ' +
        'PNG fed back to you as an image — inspect it to verify a change and self-correct. `fullPage` ' +
        'is costlier (many captures); reach for it only when you need the whole page.',
      inputSchema: ScreenshotInputSchema.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) =>
        screenshot({ type: 'screenshot', ...input }, abortSignal),
    }),
    readImages: tool({
      description:
        'Enumerate the images under `selector` (or the whole document): <img> elements and CSS ' +
        'background-images, each as a stable selector with `src`, `alt`, natural vs rendered size, ' +
        'and flags — `broken` (failed to load) and `oversized` (intrinsic pixels dwarf the rendered ' +
        'box). Cheaper than a screenshot for spotting broken / heavy images.',
      inputSchema: ReadImagesInputSchema.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) =>
        readImages({ type: 'readImages', ...input }, abortSignal),
    }),
    inspectVisually: tool({
      description:
        'Screenshot the region (`selector`, viewport, or `fullPage`) and ask the vision model your ' +
        '`question` about it — e.g. "does the CTA have enough contrast?", "is the hero image ' +
        'cropped?". ToolResult.data = { verdict, pass? }. Use it to check your own visual result; ' +
        'it costs an extra model call, so ask a specific question only when you need the judgment.',
      inputSchema: InspectVisuallyInputSchema.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) =>
        inspect({ type: 'inspectVisually', ...input }, abortSignal),
    }),
  };
}
