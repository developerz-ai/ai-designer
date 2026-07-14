// The `describe` + `readImageContent` tools for the agent loop (slice 14) — turn a page, region, or
// image into compact TEXT so a non-vision model, a report, or a handoff spec can reason without
// pixels. Derived 1:1 from the Zod input consts in `src/shared/messages.ts` (the tool NAME carries the
// `type` discriminant; `inputSchema` is that const minus `type`), the same zero-drift contract the
// other tool modules hold.
//
// Two cost tiers, routed by the injected dispatches (SW-only by usage, chrome-/model-free here):
//   • describe layout/content → `describe` dispatch → the content DOM builder (cheap, no model).
//   • describe scene          → `scene` dispatch    → screenshot + vision-model prose (SW, reusing the
//                               slice-13 `inspectVisually` capture path — one vision round-trip).
//   • readImageContent        → `readImageContent` dispatch → the image's alt/src (content) + a vision
//                               description when alt is thin (SW). Cost-aware: vision only on request.
// Dispatches are injected (wired in the agent loop), so this module stays unit-testable.

import { tool } from 'ai';
import type { DescribeInput, ReadImageContentInput } from '@/shared/messages';
import {
  DescribeInput as DescribeInputSchema,
  ReadImageContentInput as ReadImageContentInputSchema,
  ToolResult,
} from '@/shared/messages';

/** Cheap DOM-only text describe (layout / content) — a content round-trip (`data` = a DescribeResult). */
export type DescribeDispatch = (input: DescribeInput, signal?: AbortSignal) => Promise<ToolResult>;

/** Scene describe — screenshot the region + ask the vision model for prose (`data` = a DescribeResult).
 *  SW-orchestrated (owns capture + the model), reusing the `inspectVisually` path. */
export type SceneDispatch = (input: DescribeInput, signal?: AbortSignal) => Promise<ToolResult>;

/** Describe one image — its alt/src (content) plus a vision description (`data` = an ImageDescription). */
export type ReadImageContentDispatch = (
  input: ReadImageContentInput,
  signal?: AbortSignal,
) => Promise<ToolResult>;

export interface DescribeToolDeps {
  readonly describe: DescribeDispatch;
  readonly scene: SceneDispatch;
  readonly readImageContent: ReadImageContentDispatch;
}

/**
 * Build the describe `ToolSet` for one turn. `describe` routes by mode — `scene` to the vision `scene`
 * dispatch, `layout`/`content` to the cheap content `describe` dispatch — so a text ask never costs a
 * model call; `readImageContent` proxies to its dispatch. Each reattaches the tool name's `type`
 * discriminant + forwards the model's `Target`, returning the dispatch's `ToolResult` verbatim.
 */
export function createDescribeTools({ describe, scene, readImageContent }: DescribeToolDeps) {
  return {
    describe: tool({
      description:
        'Describe a page or region as compact TEXT (cheaper than a screenshot). Modes: `layout` — ' +
        'the structural skeleton (landmark regions + component counts + heading outline); `content` ' +
        '— the salient copy (title, headings, button/link labels, leading paragraphs); `scene` — a ' +
        'vision model looks at a screenshot and describes it in prose ("dark hero, centered ' +
        'headline, orange CTA on the right"). `layout` and `content` are cheap DOM reads; `scene` ' +
        'costs a vision call — reach for it only when you need what the pixels look like. ' +
        'ToolResult.data = { mode, text }.',
      inputSchema: DescribeInputSchema.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => {
        const msg: DescribeInput = { type: 'describe', ...input };
        return input.mode === 'scene' ? scene(msg, abortSignal) : describe(msg, abortSignal);
      },
    }),
    readImageContent: tool({
      description:
        'Describe one image — the `<img>` or media element matching `selector`. Returns its `alt` ' +
        'text plus a `description` of what the image depicts: the vision model’s prose, or the alt ' +
        'text when a vision call is not warranted (feeds copy/report when alt is missing). ' +
        'ToolResult.data = an ImageDescription. Cost-aware: the vision description is fetched only ' +
        'when it is needed.',
      inputSchema: ReadImageContentInputSchema.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) =>
        readImageContent({ type: 'readImageContent', ...input }, abortSignal),
    }),
  };
}
