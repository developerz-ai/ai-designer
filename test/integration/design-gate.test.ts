import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { type ToolSet, tool } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runTurn } from '@/agent/loop';
import type { DomDispatch } from '@/agent/tools/dom';
import { designSafeTools } from '@/mcp/design-gate';
import type { SwToPanel } from '@/shared/messages';

// Integration (#117): the design-turn write-tool gate, exercised through the REAL loop with the
// same merge shape background.ts uses (`{ ...designSafeTools(mcpTools), ...sessionTools }`,
// session tools elided — irrelevant here). Two invariants:
//   1. the model is never OFFERED a backend's `<id>__task` tool, so it cannot dispatch a task
//      outside the user-clicked Ship RPC (the bypass this closes);
//   2. read tools (`<id>__kb`) still reach the loop and execute — the #21 regression guard.

function usage(input: number, output: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: convertArrayToReadableStream(parts),
});

const finish = (
  u: LanguageModelV4Usage,
  unified: 'stop' | 'tool-calls',
): LanguageModelV4StreamPart => ({
  type: 'finish',
  usage: u,
  finishReason: { unified, raw: unified },
});

/** A model that calls the named tool once, then wraps up. */
function callThenStopModel(toolName: string, input: object): LanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      stream([
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 't1',
          toolName,
          input: JSON.stringify(input),
        },
        finish(usage(100, 20), 'tool-calls'),
      ]),
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Done.' },
        { type: 'text-end', id: '1' },
        finish(usage(50, 10), 'stop'),
      ]),
    ],
  });
}

const noopDispatch: DomDispatch = async () => ({ type: 'tool-result', ok: true, data: {} });
const collectEmit = () => {
  const events: SwToPanel[] = [];
  return { events, emit: (event: SwToPanel) => events.push(event) };
};

/** A connected backend's namespaced ToolSet: one write tool (task), one read tool (kb) —
 *  both with execute spies so "never ran" is a hard assertion, not an inference. */
function backendTools() {
  const taskExecute = vi.fn(async () => ({ ok: true, taskId: 'T-1' }));
  const kbExecute = vi.fn(async () => ({ tokens: ['--brand-500'] }));
  const tools: ToolSet = {
    'ai-dev__task': tool({
      description: 'Create an implementation task',
      inputSchema: z.object({ action: z.string() }),
      execute: taskExecute,
    }),
    'ai-dev__kb': tool({
      description: 'Query the repo knowledge base',
      inputSchema: z.object({ query: z.string() }),
      execute: kbExecute,
    }),
  };
  return { tools, taskExecute, kbExecute };
}

/** The tool names the model was shown on its first call. */
function offeredTools(model: MockLanguageModelV4): string[] {
  const tools = (model.doStreamCalls[0]?.tools ?? []) as Array<{ name?: string }>;
  return tools.map((t) => t.name ?? '');
}

describe('integration: the design turn never offers a backend task tool (#117)', () => {
  it('strips <id>__task from the offered toolset; a model attempt cannot execute it', async () => {
    const { tools, taskExecute } = backendTools();
    const model = callThenStopModel('ai-dev__task', { action: 'create' });
    const { emit } = collectEmit();

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'ship this design' }],
      model: model as LanguageModelV4,
      instructions: 'You are a design agent.',
      dispatch: noopDispatch,
      emit,
      tools: designSafeTools(tools),
    });

    // The gate's core invariant: the model was never offered the task tool …
    const offered = offeredTools(model as MockLanguageModelV4);
    expect(offered).toContain('ai-dev__kb');
    expect(offered).not.toContain('ai-dev__task');
    // … so its attempt to call it can never reach the backend.
    expect(taskExecute).not.toHaveBeenCalled();
    // And the turn degrades instead of crashing the SW (runTurn never throws for an
    // expected outcome — an unknown-tool call is one).
    expect(['done', 'error']).toContain(outcome.stop);
  });

  it('read tools still reach the loop and execute — the #21 regression guard', async () => {
    const { tools, kbExecute, taskExecute } = backendTools();
    const model = callThenStopModel('ai-dev__kb', { query: 'what tokens exist?' });
    const { events, emit } = collectEmit();

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'match the brand palette' }],
      model: model as LanguageModelV4,
      instructions: 'You are a design agent.',
      dispatch: noopDispatch,
      emit,
      tools: designSafeTools(tools),
    });

    expect(kbExecute).toHaveBeenCalledTimes(1);
    expect(taskExecute).not.toHaveBeenCalled();
    // The kb call surfaced as a normal tool chip on the panel stream.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-call', tool: 'ai-dev__kb' }),
    );
    expect(outcome.stop).toBe('done');
  });
});
