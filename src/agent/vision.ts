// Vision sub-call for `inspectVisually` (slice 13) — capture a region, hand it to the vision-capable
// model as an image part, and return its verdict so the agent can self-correct ("does the CTA have
// enough contrast?", "is the hero image cropped?"). SW-only by usage (it owns both the capture and
// the model — the key never crosses into the page world), chrome-free by construction: the capture
// and the model call are injected, so this stays unit-testable against a fake screenshot + a fake
// generate. Cost-aware: it runs only when the agent explicitly asks, and each call is one extra model
// round-trip (the loop's budget counts it — slice 04 budget guards, wired in a later slice-13 task).

import type { LanguageModel, ModelMessage } from 'ai';
import type {
  DescribeInput,
  DescribeResult,
  InspectVisuallyInput,
  InspectVisuallyResult,
  ScreenshotInput,
  ToolResult,
} from '@/shared/messages';

/** Screenshot the region to inspect, returning a PNG (`ToolResult.data` = base64/data-URL) or an
 *  error result. Injected so the module stays chrome-free; the SW backs it with its capture path. */
export type VisionCapture = (
  input: InspectVisuallyInput,
  signal?: AbortSignal,
) => Promise<ToolResult>;

/** The vision model text call — a structural subset of the AI SDK's `generateText` so a fake can
 *  stand in for tests; background.ts adapts the real `generateText` to this shape. */
export type GenerateVision = (args: {
  model: LanguageModel;
  messages: ModelMessage[];
  abortSignal?: AbortSignal;
}) => Promise<{ text: string }>;

export interface InspectDeps {
  /** The vision-capable model (the turn's provider model). */
  readonly model: LanguageModel;
  readonly capture: VisionCapture;
  readonly generate: GenerateVision;
}

const MAX_VERDICT = 4000; // matches InspectVisuallyResult.verdict's bound

/** The instruction that frames the screenshot review. Asks for a YES/NO lead so {@link derivePass}
 *  can distill a boolean the agent branches on, then concrete specifics for the prose verdict. */
export function inspectPrompt(question: string): string {
  return (
    'You are a meticulous UI/design reviewer. Judge ONLY the attached screenshot — do not assume ' +
    'anything not visible in it. Answer the question, starting your reply with YES or NO, then one ' +
    `or two sentences naming the specifics you see (what, and where in the image). Question: ${question}`
  );
}

/** Distill a leading YES/NO from the verdict into a boolean the agent can branch on without
 *  re-reading the prose; ambiguous or hedged prose yields `undefined` (no false certainty). The
 *  word boundary keeps "Not sure…" / "Yellowish…" from reading as a NO/YES. */
export function derivePass(verdict: string): boolean | undefined {
  const head = verdict
    .trimStart()
    .match(/^(yes|no)\b/i)?.[1]
    ?.toLowerCase();
  if (head === 'yes') return true;
  if (head === 'no') return false;
  return undefined;
}

/**
 * Run one visual inspection: capture the region, ask the vision model the question about it, and
 * return its verdict as `ToolResult.data` ({@link InspectVisuallyResult}). A failed capture or a
 * model error surfaces as an error `ToolResult` the agent reacts to — never a throw.
 */
export async function runInspect(
  deps: InspectDeps,
  input: InspectVisuallyInput,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const shot = await deps.capture(input, signal);
  if (!shot.ok || typeof shot.data !== 'string') {
    return {
      type: 'tool-result',
      ok: false,
      error: shot.error ?? 'Could not capture the region to inspect.',
    };
  }

  let text: string;
  try {
    ({ text } = await deps.generate({
      model: deps.model,
      abortSignal: signal,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: inspectPrompt(input.question) },
            { type: 'image', image: shot.data },
          ],
        },
      ],
    }));
  } catch (err) {
    return { type: 'tool-result', ok: false, error: `Vision check failed: ${String(err)}` };
  }

  const verdict = text.trim().slice(0, MAX_VERDICT);
  const pass = derivePass(text);
  const data: InspectVisuallyResult = { verdict, ...(pass !== undefined ? { pass } : {}) };
  return { type: 'tool-result', ok: true, data };
}

// --- `describe` scene mode (slice 14) ---------------------------------------------------------
// `describe`'s `layout`/`content` modes are cheap DOM-only text (content-routed, never reach here);
// `scene` is the one mode that costs a vision call — screenshot the region, ask the model for prose,
// same capture-then-generate shape as `runInspect` above, reusing its capture path rather than a
// second screenshot pipeline. SW-only, chrome-free by construction (capture + generate injected).

const MAX_SCENE_TEXT = 8000; // matches DescribeResult.text's bound

/** Screenshot the region `describe(mode:'scene')` asks about — the same crop/fullPage transport
 *  `screenshot` uses, injected so this module stays chrome-free and testable. */
export type SceneCapture = (input: ScreenshotInput, signal?: AbortSignal) => Promise<ToolResult>;

export interface DescribeSceneDeps {
  /** The vision-capable model (the turn's provider model). */
  readonly model: LanguageModel;
  readonly capture: SceneCapture;
  readonly generate: GenerateVision;
}

/** Frames the scene-description ask: prose only, no verdict — `describe` wants a compact scene
 *  narration ("dark hero, centered headline, orange CTA right"), not a yes/no judgment. */
export function describeScenePrompt(): string {
  return (
    'Describe this screenshot in compact prose for a design report: the layout, dominant colors, ' +
    'typography feel, and any notable components. Two or three sentences, concrete and specific — ' +
    'name what you see and roughly where, no filler.'
  );
}

/**
 * Run one `describe(mode:'scene')` call: capture the region, ask the vision model to narrate it in
 * prose, and return `ToolResult.data` as a {@link DescribeResult}. A failed capture or a model error
 * surfaces as an error `ToolResult`, mirroring {@link runInspect} — never a throw.
 */
export async function runDescribeScene(
  deps: DescribeSceneDeps,
  input: DescribeInput,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const shot = await deps.capture(
    { type: 'screenshot', selector: input.selector, tabId: input.tabId, frameId: input.frameId },
    signal,
  );
  if (!shot.ok || typeof shot.data !== 'string') {
    return {
      type: 'tool-result',
      ok: false,
      error: shot.error ?? 'Could not capture the region to describe.',
    };
  }

  let text: string;
  try {
    ({ text } = await deps.generate({
      model: deps.model,
      abortSignal: signal,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: describeScenePrompt() },
            { type: 'image', image: shot.data },
          ],
        },
      ],
    }));
  } catch (err) {
    return { type: 'tool-result', ok: false, error: `Scene description failed: ${String(err)}` };
  }

  const data: DescribeResult = { mode: 'scene', text: text.trim().slice(0, MAX_SCENE_TEXT) };
  return { type: 'tool-result', ok: true, data };
}
