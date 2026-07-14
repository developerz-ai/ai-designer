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
import type { SwToPanel, ToolResult } from '@/shared/messages';
import {
  type BudgetLimits,
  type BudgetReason,
  type BudgetUsage,
  TurnBudget,
  usageOf,
} from './budget';
import type { ChatMessage } from './session';
import { createDomTools, type DomDispatch } from './tools/dom';

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
  /** Sink for stream events → the side-panel port (`postToPanel`). */
  readonly emit: (event: SwToPanel) => void;
  /** Extra tools merged after the DOM tools: connected MCP tools (02), session/recorder (07). */
  readonly tools?: ToolSet;
  /** Per-turn step/token ceilings. */
  readonly limits?: BudgetLimits;
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
  const limits = args.limits ?? undefined;
  const budget = new TurnBudget(limits);
  const tools = buildTools(dispatch, args.tools);
  const agent = new ToolLoopAgent({
    model,
    instructions,
    tools,
    // Two ceilings: native step cap + a token cap computed from each step's usage. Either stops
    // the loop after the current step; `budget` (fed by `onStepFinish`) reports which fired.
    stopWhen: [
      isStepCount(budget.limits.maxSteps),
      ({ steps }) => usageOf(steps).tokens >= budget.limits.maxTokens,
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
        case 'tool-call':
          emit({ type: 'tool-call', tool: part.toolName });
          break;
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

  // Force-stopped on budget: stream the stop-and-summarize notice so the user sees why it ended.
  if (stop === 'done' && budget.exhausted) {
    stop = 'budget';
    const notice = budget.notice();
    if (notice) {
      const chunk = text ? `\n\n${notice}` : notice;
      text += chunk;
      emit({ type: 'token', text: chunk });
    }
  }

  return { text, usage: budget.usage, stop, budgetReason: budget.reason };
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

/** Build the turn's ToolSet: DOM tools (with the screenshot vision hook) + any injected extras
 *  (MCP, session). Extras win on a name clash — a backend can't be shadowed by a DOM tool. */
function buildTools(dispatch: DomDispatch, extra?: ToolSet): ToolSet {
  const dom = createDomTools(dispatch);
  const screenshot = { ...dom.screenshot, toModelOutput: screenshotToModelOutput };
  return { ...dom, screenshot, ...(extra ?? {}) };
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
