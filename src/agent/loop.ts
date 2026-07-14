// The agent turn — one user instruction driven to a finished, verified result by a bounded
// `ToolLoopAgent` in the service worker (docs/idea/agent.md, docs/reference/agent-sdk.md). The
// model reads/mutates the live page only through tools (it has no DOM handle); text + tool
// calls stream out to the side-panel port as they arrive. This is the single biggest gap the
// slice-04 plan calls out.
//
// SW-ONLY by usage, but chrome-free by construction: every side effect is injected — the model
// (`createProvider`, slice 01), the DOM transport (`dispatch` → content script, slice 05), the
// panel sink (`emit` → port), and any extra tools (MCP, slice 02; session/recorder, slice 07).
// That keeps the loop unit/integration-testable against a mock model with no `chrome.*`.

import { isStepCount, type LanguageModel, ToolLoopAgent, type ToolSet } from 'ai';
import type {
  ControlTool,
  NavIntent,
  ResponsiveShot,
  SwToPanel,
  ToolResult,
} from '@/shared/messages';
import { classifyTool } from '@/shared/overlay-step';
import {
  type BudgetLimits,
  type BudgetReason,
  type BudgetUsage,
  TurnBudget,
  usageOf,
} from './budget';
import type { ChatMessage } from './session';
import { type BrowseDispatch, createBrowseTool } from './tools/browse';
import { type ComplexSiteDispatch, createComplexSiteTools } from './tools/complex-site';
import { createDescribeTools, type DescribeToolDeps } from './tools/describe';
import { createDomTools, type DomDispatch } from './tools/dom';
import { createIdentityTool, type IdentityDispatch } from './tools/identity';
import { createInteractTools, type InteractDeps } from './tools/interact';
import { createResponsiveTools, type ResponsiveToolDeps } from './tools/responsive';
import { createTabsTools, type TabsToolDeps } from './tools/tabs';
import { createVisionTools, type VisionToolDeps } from './tools/vision';

// Shown alongside a screenshot fed back to the model, so it reads the image as its own result
// to judge and refine — the vision self-correction loop (docs/architecture/agent-loop.md).
const SCREENSHOT_HINT =
  'Screenshot of the current result. Inspect it and refine if it does not yet match the intent.';

/** How the agent turn ended. `budget` = force-stopped on the step/token ceiling; `aborted` =
 *  the caller's signal fired (user Stop / superseded turn); `error` = the run threw. */
export type TurnStop = 'done' | 'budget' | 'aborted' | 'error';

export interface TurnOutcome {
  /** The assistant's final prose, for appending to the session thread. */
  readonly text: string;
  readonly usage: BudgetUsage;
  readonly stop: TurnStop;
  readonly budgetReason: BudgetReason | null;
}

export interface RunTurnArgs {
  /** Conversation so far (from the session thread); the new user message is already appended. */
  readonly messages: ChatMessage[];
  /** The tab whose content script `dispatch` targets — scopes this turn to one page. */
  readonly tabId: number;
  /** Aborts the turn mid-stream (user Stop, or a newer instruction superseding this one). */
  readonly signal?: AbortSignal;
  /** The provider model to drive (built from the BYOK config in the SW, slice 01). */
  readonly model: LanguageModel;
  /** The design-agent system prompt (`buildSystemPrompt`). Passed as `instructions` (v7). */
  readonly instructions: string;
  /** Bus round-trip that runs a DOM tool in the tab's content script (slice 05). */
  readonly dispatch: DomDispatch;
  /** Opens a reference site in a background tab and returns its compact design read (slice 06).
   *  Absent ⇒ the `browse` tool isn't offered this turn (e.g. a context with no tab access). */
  readonly browse?: BrowseDispatch;
  /** Browser-control interaction dispatches (click/type/…/waitFor + navigate/back/reload,
   *  slice 13). Absent ⇒ the drive-the-page tools aren't offered this turn. */
  readonly interact?: InteractDeps;
  /** Multi-tab + frame-enumeration dispatches (slice 13). Absent ⇒ `tabs`/`frames` aren't
   *  offered this turn. */
  readonly tabsFrames?: TabsToolDeps;
  /** Vision dispatches — `screenshot` (with `fullPage`), `readImages`, `inspectVisually`
   *  (slice 13). Absent ⇒ falls back to the DOM tools' plain `screenshot` only. */
  readonly vision?: VisionToolDeps;
  /** `extractIdentity` dispatch — a content round-trip that reduces the live page to a role-tagged
   *  palette + type scale + spacing/radius/shadow rhythm (slice 14). Absent ⇒ `extractIdentity`
   *  isn't offered this turn. Copy mode leans on it first: read the reference's identity, then
   *  apply it to the user's page, rather than eyeballing a screenshot. */
  readonly identity?: IdentityDispatch;
  /** `describe` (layout/content DOM-only, scene vision) + `readImageContent` dispatches (slice
   *  14). Absent ⇒ neither tool is offered this turn. `describe` is the cheap text-first read the
   *  system prompt asks the model to prefer over a screenshot when vision isn't warranted. */
  readonly describe?: DescribeToolDeps;
  /** `pageFacts`/`readChart`/`chartTooltip`/`widgetAct` dispatch (slice 15) — same content-routed
   *  transport as `interact.control`. Absent ⇒ none of the complex-site tools are offered this turn. */
  readonly complexSite?: ComplexSiteDispatch;
  /** Device-emulation + responsive dispatches (slice 16): `setDevice` (CDP/fallback) +
   *  `responsiveCapture` (multi-breakpoint, SW-orchestrated) + `checkResponsive` (content scan).
   *  Absent ⇒ the responsive tools aren't offered this turn. `responsiveCapture` is wrapped with the
   *  vision budget guard (it screenshots per breakpoint). */
  readonly responsive?: ResponsiveToolDeps;
  /** Sink for stream events → the side-panel port (`postToPanel`). */
  readonly emit: (event: SwToPanel) => void;
  /** Extra tools merged after the built-ins: connected MCP tools (02), session/recorder (07). */
  readonly tools?: ToolSet;
  /** Per-turn step/token/vision/wait/nav ceilings (see {@link BudgetLimits}); any omitted field
   *  falls back to {@link DEFAULT_BUDGET}. */
  readonly limits?: Partial<BudgetLimits>;
  /** Ship approval gate for the `handoff` tool (07). Absent/false ⇒ handoff never runs — the
   *  agent never ships on its own (docs/idea/principles.md). */
  readonly approveHandoff?: () => boolean | Promise<boolean>;
}

/**
 * Run one agent turn to completion, streaming tokens + tool-call chips to the panel. Returns
 * how it ended and what it spent so the caller can persist usage and thread the assistant's
 * reply. Never throws for an expected outcome (budget, abort, model error) — those surface as
 * a `TurnStop` and, for errors, an `error` event on `emit`.
 */
export async function runTurn(args: RunTurnArgs): Promise<TurnOutcome> {
  const { messages, signal, model, instructions, dispatch, emit } = args;
  const budget = new TurnBudget(args.limits);
  const tools = buildTools(dispatch, budget, args);
  // Did the loop actually terminate on one of our stopWhen ceilings? The SDK only evaluates
  // `stopWhen` when a step has tool calls it could continue from — a naturally-finished turn
  // (finishReason `stop`) never consults it. So we can't infer "force-stopped on budget" from
  // `budget.exhausted` alone: a turn that completes on its own but whose final tokens happen to
  // cross the ceiling would be mislabeled `budget` with a spurious "reached the budget" notice.
  // Tracking which stopWhen fired distinguishes the two.
  let ceilingHit = false;
  const stepCeiling = isStepCount(budget.limits.maxSteps);
  const agent = new ToolLoopAgent({
    model,
    instructions,
    tools,
    // Two ceilings: native step cap + a token cap computed from each step's usage. Either stops
    // the loop after the current step; `ceilingHit` records that it was a ceiling (not a natural
    // finish) that ended the loop, and `budget` (fed by `onStepFinish`) reports which fired.
    stopWhen: [
      (opts) => {
        const hit = stepCeiling(opts);
        if (hit) ceilingHit = true;
        return hit;
      },
      ({ steps }) => {
        const hit = usageOf(steps).tokens >= budget.limits.maxTokens;
        if (hit) ceilingHit = true;
        return hit;
      },
    ],
    // Gate `handoff` on the user's Ship click — never auto-ship. Only wired when a handoff tool
    // is present (slice 07); the key is a plain string on the widened ToolSet until then.
    ...('handoff' in tools
      ? {
          toolApproval: {
            handoff: async () => ((await args.approveHandoff?.()) ? 'approved' : 'denied'),
          },
        }
      : {}),
  });

  let text = '';
  let stop: TurnStop = 'done';

  try {
    const result = await agent.stream({
      messages,
      abortSignal: signal,
      onStepFinish: (step) => budget.record(step.usage),
    });

    for await (const part of result.stream) {
      switch (part.type) {
        case 'text-delta':
          if (part.text) {
            text += part.text;
            emit({ type: 'token', text: part.text });
          }
          break;
        case 'tool-call': {
          // `selector`/`kind` (slice 09): feeds the future panel tool chip and, when the on-page
          // overlay is opted in, background.ts's `forwardOverlayStep` mirror to content.
          const { selector, kind } = classifyTool(part.toolName, part.input);
          emit({ type: 'tool-call', tool: part.toolName, selector, kind });
          break;
        }
        case 'abort':
          stop = 'aborted';
          break;
        case 'error':
          stop = 'error';
          emit({ type: 'error', message: errorText(part.error) });
          break;
        default:
          break;
      }
    }
  } catch (err) {
    // A fired signal surfaces as a throw on some providers — treat it as the user abort it is,
    // not an error the panel should show.
    if (signal?.aborted) return { text, usage: budget.usage, stop: 'aborted', budgetReason: null };
    emit({ type: 'error', message: errorText(err) });
    return { text, usage: budget.usage, stop: 'error', budgetReason: budget.reason };
  }

  // Force-stopped on a budget ceiling: stream the stop-and-summarize notice so the user sees why
  // it ended. Gated on `ceilingHit` (a stopWhen actually fired), not `budget.exhausted` — a turn
  // that finished on its own must not be relabeled/annotated just because its final tokens crossed
  // the line.
  if (stop === 'done' && ceilingHit) {
    stop = 'budget';
    const notice = budget.notice();
    if (notice) {
      const chunk = text ? `\n\n${notice}` : notice;
      text += chunk;
      emit({ type: 'token', text: chunk });
    }
  }

  return {
    text,
    usage: budget.usage,
    stop,
    budgetReason: stop === 'budget' ? budget.reason : null,
  };
}

// A minimal structural view of the tool output the model sees — a superset-safe subset of the
// SDK's `ToolResultOutput`, so we can build it without importing an SDK-internal type. `content`
// lets a screenshot come back as an image part the (vision) model can actually look at.
export type ModelToolOutput =
  | { type: 'text'; value: string }
  | {
      type: 'content';
      value: Array<
        | { type: 'text'; text: string }
        | { type: 'file'; data: { type: 'data'; data: string }; mediaType: string }
      >;
    };

/** Just the tool-building slice of {@link RunTurnArgs} — kept separate so `buildTools` doesn't
 *  need the whole turn's args (messages, model, emit, …) to assemble the ToolSet. */
type ToolDeps = Pick<
  RunTurnArgs,
  | 'browse'
  | 'interact'
  | 'tabsFrames'
  | 'vision'
  | 'identity'
  | 'describe'
  | 'complexSite'
  | 'responsive'
  | 'tools'
>;

/** Build the turn's ToolSet: DOM tools, the cross-site `browse` tool, browser-control
 *  (interact/tabs/frames/vision, slice 13), `extractIdentity` + `describe`/`readImageContent`
 *  (slice 14) — each only when its dispatch is injected — + any injected extras (MCP, session).
 *  Extras win on a name clash — a backend can't be shadowed by a built-in tool. The
 *  `waitFor`/`navigate*`/`inspectVisually` dispatches are wrapped with `budget`'s per-tool guards
 *  so a runaway loop fails that call, not the whole turn. Whichever `screenshot` tool survives the
 *  merge (vision's `fullPage`-capable one if present, else the DOM one) gets the image→model hook
 *  so a returned PNG is fed back as a vision part. */
function buildTools(dispatch: DomDispatch, budget: TurnBudget, deps: ToolDeps): ToolSet {
  const dom = createDomTools(dispatch);
  const cross = deps.browse ? createBrowseTool(deps.browse) : {};
  const interact = deps.interact
    ? createInteractTools(guardInteractDeps(deps.interact, budget))
    : {};
  const tabsFrames = deps.tabsFrames ? createTabsTools(deps.tabsFrames) : {};
  const vision = deps.vision ? createVisionTools(guardVisionDeps(deps.vision, budget)) : {};
  const identity = deps.identity ? createIdentityTool(deps.identity) : {};
  const describeTools = deps.describe ? createDescribeTools(deps.describe) : {};
  const complexSite = deps.complexSite ? createComplexSiteTools(deps.complexSite) : {};
  const responsive = deps.responsive
    ? createResponsiveTools(guardResponsiveDeps(deps.responsive, budget))
    : {};

  const merged: ToolSet = {
    ...dom,
    ...cross,
    ...interact,
    ...tabsFrames,
    ...vision,
    ...identity,
    ...describeTools,
    ...complexSite,
    ...responsive,
  };
  // Whichever `screenshot` survived the merge (vision's `fullPage`-capable one if present, else the
  // DOM one) and `responsiveCapture` get an image→model hook so their PNGs are fed back as vision
  // parts instead of JSON — `responsiveCapture` fans its shots out labeled by breakpoint.
  const base = merged.screenshot;
  const screenshot = base ? { ...base, toModelOutput: screenshotToModelOutput } : undefined;
  const captureBase = merged.responsiveCapture;
  const responsiveCapture = captureBase
    ? { ...captureBase, toModelOutput: responsiveCaptureToModelOutput }
    : undefined;

  return {
    ...merged,
    ...(screenshot ? { screenshot } : {}),
    ...(responsiveCapture ? { responsiveCapture } : {}),
    ...(deps.tools ?? {}),
  };
}

// The ToolResult a guarded call returns once its per-tool budget is exhausted — the model reacts
// to it like any other tool failure (its `error` names the ceiling), rather than the turn dying.
const guardExceeded = (what: string): ToolResult => ({
  type: 'tool-result',
  ok: false,
  error:
    `${what} budget for this turn is exhausted — stop retrying this and move on, or tell ` +
    'the user what you need before continuing.',
});

/** Cap `waitFor` re-tries (a stuck page can otherwise be re-waited every step) and `navigate` /
 *  `navigateBack` / `reload` bouncing, without touching `src/agent/tools/interact.ts` — the guard
 *  wraps the injected dispatches by inspecting the reassembled message's `type`. */
function guardInteractDeps(deps: InteractDeps, budget: TurnBudget): InteractDeps {
  return {
    control: (msg: ControlTool, signal?: AbortSignal) => {
      if (msg.type === 'waitFor' && !budget.spendWait()) {
        return Promise.resolve(guardExceeded('The `waitFor`'));
      }
      return deps.control(msg, signal);
    },
    nav: (msg: NavIntent, signal?: AbortSignal) => {
      if (!budget.spendNav()) return Promise.resolve(guardExceeded('The `navigate`/`reload`'));
      return deps.nav(msg, signal);
    },
  };
}

/** Cap `inspectVisually`'s extra vision-model round-trips — invisible to the step/token ceilings
 *  since it doesn't go through `onStepFinish` (it calls the model itself, inside the tool). */
function guardVisionDeps(deps: VisionToolDeps, budget: TurnBudget): VisionToolDeps {
  return {
    ...deps,
    inspect: (msg, signal) => {
      if (!budget.spendVision()) return Promise.resolve(guardExceeded('The `inspectVisually`'));
      return deps.inspect(msg, signal);
    },
  };
}

/** Cap `responsiveCapture` against the same vision budget as `inspectVisually` — each sweep is a
 *  screenshot-per-breakpoint burst of vision tokens, so a runaway multi-breakpoint loop shouldn't
 *  outlast the guard. `setDevice`/`checkResponsive` are cheap and pass through unguarded. */
function guardResponsiveDeps(deps: ResponsiveToolDeps, budget: TurnBudget): ResponsiveToolDeps {
  return {
    ...deps,
    capture: (msg, signal) => {
      if (!budget.spendVision()) return Promise.resolve(guardExceeded('The `responsiveCapture`'));
      return deps.capture(msg, signal);
    },
  };
}

// Present a successful `screenshot` result to the model as a PNG image part (vision
// self-correction). A failed capture or non-image payload falls back to the default JSON view.
// Exported for unit coverage of the vision hook.
export function screenshotToModelOutput({ output }: { output: ToolResult }): ModelToolOutput {
  if (output.ok && typeof output.data === 'string') {
    return {
      type: 'content',
      value: [
        { type: 'text', text: SCREENSHOT_HINT },
        {
          type: 'file',
          data: { type: 'data', data: stripDataUrl(output.data) },
          mediaType: 'image/png',
        },
      ],
    };
  }
  return { type: 'text', value: JSON.stringify(output) };
}

// Present a `responsiveCapture` result to the model as an interleaved set of labeled PNGs (one per
// breakpoint), so the vision model compares how the design holds up across sizes. Each shot with an
// image becomes a caption text part + a file part; a shot that failed to capture keeps its error
// caption. With no images at all, falls back to the default JSON view. Exported for unit coverage.
export function responsiveCaptureToModelOutput({
  output,
}: {
  output: ToolResult;
}): ModelToolOutput {
  const shots = shotsOf(output);
  const value: Array<
    | { type: 'text'; text: string }
    | { type: 'file'; data: { type: 'data'; data: string }; mediaType: string }
  > = [];
  for (const shot of shots) {
    const size = `${shot.metrics.width}×${shot.metrics.height}`;
    if (shot.image) {
      value.push({ type: 'text', text: `${shot.label} (${size}, ${shot.mechanism})` });
      value.push({
        type: 'file',
        data: { type: 'data', data: stripDataUrl(shot.image) },
        mediaType: 'image/png',
      });
    } else {
      value.push({ type: 'text', text: `${shot.label} (${size}): ${shot.error ?? 'no capture'}` });
    }
  }
  return value.some((part) => part.type === 'file')
    ? { type: 'content', value }
    : { type: 'text', value: JSON.stringify(output) };
}

// Structurally read the shots off a successful `responsiveCapture` result — `ToolResult.data` is
// `unknown` on the bus, so narrow defensively rather than trust its shape.
function shotsOf(output: ToolResult): ResponsiveShot[] {
  if (!output.ok || typeof output.data !== 'object' || output.data === null) return [];
  const shots = (output.data as { shots?: unknown }).shots;
  return Array.isArray(shots) ? (shots as ResponsiveShot[]) : [];
}

/** Drop a `data:*;base64,` prefix so a data-URL screenshot becomes the bare base64 the SDK's
 *  file part expects; a bare base64 string passes through unchanged. */
function stripDataUrl(data: string): string {
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1;
  return comma >= 0 ? data.slice(comma + 1) : data;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'The agent hit an unexpected error.';
}
