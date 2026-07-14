import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { runTurn } from '@/agent/loop';
import type { DomDispatch } from '@/agent/tools/dom';
import type { DomTool, SwToPanel } from '@/shared/messages';

// Integration: the slice-04 spine — a `user-message` turn runs the ToolLoopAgent in the SW
// against a MOCKED model (no network), streams tokens + a tool-call to the panel sink, and
// round-trips a setStyle DOM tool to a fake content script. Mirrors background.ts's user-message
// wiring (which can't be imported under Vitest — it pulls the WXT `#imports` virtual module),
// exactly like readiness.test.ts reproduces its handler against the real modules.

// v4 token usage in the provider's nested shape; the SDK flattens it to { inputTokens, ... }.
function usage(input: number, output: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: convertArrayToReadableStream(parts),
});

// v4 finish part: `finishReason` is a `{ unified, raw }` object, not a bare string.
const finish = (
  u: LanguageModelV4Usage,
  unified: 'stop' | 'tool-calls',
): LanguageModelV4StreamPart => ({
  type: 'finish',
  usage: u,
  finishReason: { unified, raw: unified },
});

// A model that, on its first call, narrates + calls setStyle, then on its second call wraps up.
// Two calls model the real agentic loop: mutate (step 1) → observe result → summarize (step 2).
function twoStepModel(): LanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Making the CTA orange. ' },
        { type: 'text-end', id: '1' },
        {
          type: 'tool-call',
          toolCallId: 't1',
          toolName: 'setStyle',
          input: JSON.stringify({ selector: '#cta', props: { 'background-color': '#f97316' } }),
        },
        finish(usage(500, 100), 'tool-calls'),
      ]),
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '2' },
        { type: 'text-delta', id: '2', delta: 'Done — the CTA now pops.' },
        { type: 'text-end', id: '2' },
        finish(usage(600, 40), 'stop'),
      ]),
    ],
  });
}

// Fake content script: record every DomTool it receives, echo a ToolResult back to the loop.
function fakeContent() {
  const calls: DomTool[] = [];
  const dispatch: DomDispatch = async (message) => {
    calls.push(message);
    return { type: 'tool-result', ok: true, data: { 'background-color': '#f97316' } };
  };
  return { calls, dispatch };
}

function collectEmit() {
  const events: SwToPanel[] = [];
  return { events, emit: (event: SwToPanel) => events.push(event) };
}

const tokensOf = (events: SwToPanel[]) =>
  events
    .filter((e): e is Extract<SwToPanel, { type: 'token' }> => e.type === 'token')
    .map((e) => e.text)
    .join('');

describe('integration: agent turn streams tokens + tool-calls and drives the DOM bus', () => {
  it('runs a multi-step turn: narrate → setStyle → summarize', async () => {
    const { calls, dispatch } = fakeContent();
    const { events, emit } = collectEmit();

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'make the CTA orange' }],
      model: twoStepModel(),
      instructions: 'You are a design agent.',
      dispatch,
      emit,
    });

    // The tool call was reassembled into a valid DomTool and routed to the content script.
    expect(calls).toEqual([
      { type: 'setStyle', selector: '#cta', props: { 'background-color': '#f97316' } },
    ]);

    // A tool-call chip surfaced on the panel stream, named by the tool.
    const toolCalls = events.filter((e) => e.type === 'tool-call');
    expect(toolCalls).toContainEqual({ type: 'tool-call', tool: 'setStyle' });

    // Prose from both steps streamed as tokens.
    const text = tokensOf(events);
    expect(text).toContain('Making the CTA orange');
    expect(text).toContain('Done — the CTA now pops');

    // Natural completion, spend summed across both steps (500+100 + 600+40).
    expect(outcome.stop).toBe('done');
    expect(outcome.budgetReason).toBeNull();
    expect(outcome.usage).toEqual({ steps: 2, tokens: 1240 });
    expect(outcome.text).toContain('Done — the CTA now pops');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('stops and summarizes when the step budget is exhausted mid-turn', async () => {
    const { calls, dispatch } = fakeContent();
    const { events, emit } = collectEmit();

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'make the CTA orange' }],
      model: twoStepModel(),
      instructions: 'You are a design agent.',
      dispatch,
      emit,
      limits: { maxSteps: 1, maxTokens: 1_000_000 },
    });

    // Capped after the first step: the tool ran once, the second model call never happened.
    expect(calls).toHaveLength(1);
    expect(outcome.stop).toBe('budget');
    expect(outcome.budgetReason).toBe('steps');
    expect(outcome.usage.steps).toBe(1);
    // The stop-and-summarize notice streamed to the panel.
    expect(tokensOf(events).toLowerCase()).toContain('budget');
  });

  it('reports an aborted turn without emitting an error', async () => {
    const { dispatch } = fakeContent();
    const { events, emit } = collectEmit();
    const controller = new AbortController();
    controller.abort();

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'make the CTA orange' }],
      model: twoStepModel(),
      instructions: 'You are a design agent.',
      dispatch,
      emit,
      signal: controller.signal,
    });

    expect(outcome.stop).toBe('aborted');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('surfaces a model error as an error event, not a throw', async () => {
    const { dispatch } = fakeContent();
    const { events, emit } = collectEmit();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('provider exploded');
      },
    });

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'hi' }],
      model,
      instructions: 'You are a design agent.',
      dispatch,
      emit,
    });

    expect(outcome.stop).toBe('error');
    expect(events).toContainEqual({ type: 'error', message: 'provider exploded' });
  });
});
