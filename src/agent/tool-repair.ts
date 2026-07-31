// Recoverable tool-call failures (#168). Live evidence: a model emitted a tool call with an
// EMPTY name on turn 2 and the whole step died with `AI_NoSuchToolError` — the model never got
// a chance to read its mistake and try again. This module turns both parse-time failure modes
// (`NoSuchToolError`: unknown/empty name; `InvalidToolInputError`: schema-invalid arguments)
// into a normal error TOOL RESULT the model reacts to, via the SDK's repair hook
// (`experimental_repairToolCall`, ai@7.0.19): the broken call is rewritten to target
// `invalidTool` — a real tool in the turn's ToolSet whose only job is to echo the problem back —
// so the transcript stays provider-valid (a non-empty tool name with a matching tool result)
// and the loop continues instead of failing the step.
//
// Why a fallback TOOL and not repair-to-null: returning `null` from the hook rethrows the
// original error, and the SDK's invalid-call path then records an assistant tool-call part with
// the EMPTY name — which the next OpenAI-compatible request rejects. Rewriting to a real tool
// keeps every message the provider sees well-formed.
//
// SW-only by usage, chrome-free by construction. No `any`.

import {
  InvalidToolInputError,
  NoSuchToolError,
  type ToolCallRepairFunction,
  type ToolSet,
  tool,
} from 'ai';
import { z } from 'zod';
import { ToolResult } from '@/shared/messages';

/** The fallback tool's name — what a repaired broken call targets. Reserved: an MCP extra of
 *  the same name would shadow the repair channel, so `loop.ts` merges this set last-but-one. */
export const INVALID_TOOL_NAME = 'invalidTool';

// Bound what one repair feeds back — a zod error naming 40 fields must not flood the step.
const MAX_PROBLEM_CHARS = 1_200;

const InvalidToolInput = z.object({
  requestedTool: z.string(),
  problem: z.string(),
});

/**
 * The fallback ToolSet entry. Its `execute` never touches the page — it just returns the
 * `problem` as a failed `ToolResult`, which reaches the model as an error tool-result (and the
 * panel as a red chip via the loop's normal `toolOutcome` path).
 */
export function createInvalidToolFallback() {
  return {
    [INVALID_TOOL_NAME]: tool({
      description:
        'Internal error channel — never call this yourself. Broken tool calls (unknown tool ' +
        'name, invalid arguments) are rerouted here so you can read what went wrong and retry ' +
        'with a valid call.',
      inputSchema: InvalidToolInput,
      outputSchema: ToolResult,
      execute: ({ problem }): Promise<ToolResult> =>
        Promise.resolve({ type: 'tool-result', ok: false, error: problem }),
    }),
  };
}

/**
 * The `experimental_repairToolCall` hook for the turn's agent. Rewrites a call that failed to
 * parse into an `invalidTool` call carrying a problem statement the model can act on:
 * unknown/empty names get the valid tool list; schema-invalid input gets the validation message
 * and an instruction to re-read the schema. Any other error returns `null` (SDK default
 * handling) — repair is for the model's mistakes, not for transport faults.
 */
export function createRepairToolCall(): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, tools, error }) => {
    const problem = problemOf(error, tools);
    if (problem === null) return null;
    return {
      type: 'tool-call' as const,
      toolCallId: toolCall.toolCallId,
      toolName: INVALID_TOOL_NAME,
      input: JSON.stringify({
        requestedTool: toolCall.toolName,
        problem: problem.slice(0, MAX_PROBLEM_CHARS),
      } satisfies z.infer<typeof InvalidToolInput>),
    };
  };
}

function problemOf(error: unknown, tools: ToolSet): string | null {
  if (NoSuchToolError.isInstance(error)) {
    const requested = error.toolName === '' ? '(empty tool name)' : `'${error.toolName}'`;
    return (
      `You called an unavailable tool: ${requested}. Nothing was executed. ` +
      `Valid tools this turn: ${validToolNames(tools)}. ` +
      'Call one of those, with its documented input.'
    );
  }
  if (InvalidToolInputError.isInstance(error)) {
    // Instruction first, validation detail second — the panel chip and some providers bound
    // error strings, and the actionable half must survive the cut.
    return (
      `Your input for tool '${error.toolName}' failed validation; nothing was executed. ` +
      'Re-read the tool description and retry with arguments matching its input schema. ' +
      `Validation said: ${error.message}`
    );
  }
  return null;
}

function validToolNames(tools: ToolSet): string {
  return Object.keys(tools)
    .filter((name) => name !== INVALID_TOOL_NAME)
    .join(', ');
}
