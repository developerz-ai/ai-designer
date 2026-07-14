import type {
  LanguageModelV4,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { runTurn } from '@/agent/loop';
import type { DomDispatch } from '@/agent/tools/dom';
import { createSessionTools } from '@/agent/tools/session';
import { ChangesetStore } from '@/changeset/store';
import { emptyChangeset } from '@/shared/changeset';
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

// The `handoff` guardrail: docs/idea/principles.md — the agent never ships on its own. The loop
// gates `handoff` behind `args.approveHandoff` (a `toolApproval` entry, see loop.ts); this proves
// the gate actually reaches the model, not just that the option is wired.

// A model that calls `handoff` on step one, then wraps up on step two once it sees whether the
// call was approved or denied — mirrors the shape of `twoStepModel` above.
function handoffModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      stream([
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 't1',
          toolName: 'handoff',
          input: JSON.stringify({ summary: 'Recolor the CTA' }),
        },
        finish(usage(100, 10), 'tool-calls'),
      ]),
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '2' },
        { type: 'text-delta', id: '2', delta: 'Noted.' },
        { type: 'text-end', id: '2' },
        finish(usage(50, 5), 'stop'),
      ]),
    ],
  });
}

function fakeSessionTools() {
  const store = new ChangesetStore(
    emptyChangeset('https://example.com/', '2026-07-13T00:00:00Z', 's1'),
  );
  return createSessionTools({ store, persist: () => undefined, emit: () => undefined });
}

// What the model was shown for the `handoff` tool call in its second turn — the loop's only
// observable proof the gate fired one way or the other, since `emit` surfaces just the tool name.
function handoffResultShownToModel(model: MockLanguageModelV4): LanguageModelV4ToolResultOutput {
  const prompt = model.doStreamCalls[1]?.prompt as LanguageModelV4Prompt | undefined;
  const last = prompt?.[prompt.length - 1];
  if (last?.role !== 'tool') throw new Error('expected a tool-result message');
  const [part] = last.content;
  if (part?.type !== 'tool-result') throw new Error('expected a tool-result part');
  return part.output;
}

describe('integration: the handoff tool is gated by approveHandoff — never ships on its own', () => {
  it('denies the call when approveHandoff resolves false; handoff.execute never runs', async () => {
    const { events, emit } = collectEmit();
    const model = handoffModel();

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'ship it' }],
      model,
      instructions: 'You are a design agent.',
      dispatch: fakeContent().dispatch,
      emit,
      tools: fakeSessionTools(),
      approveHandoff: () => false,
    });

    // The model still sees the call happen (chip surfaces either way) …
    expect(events).toContainEqual({ type: 'tool-call', tool: 'handoff' });
    // … but the SDK reports the execution itself was denied — `handoff.execute` never ran, so
    // the model never received a fabricated "shipped" result to act on.
    expect(handoffResultShownToModel(model)).toEqual({ type: 'execution-denied' });
    expect(outcome.stop).toBe('done');
  });

  it('approves the call when approveHandoff resolves true; execute runs and reports the proposal', async () => {
    const model = handoffModel();
    const { emit } = collectEmit();

    await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'ship it' }],
      model,
      instructions: 'You are a design agent.',
      dispatch: fakeContent().dispatch,
      emit,
      tools: fakeSessionTools(),
      approveHandoff: () => true,
    });

    const output = handoffResultShownToModel(model);
    expect(output.type).toBe('json');
    if (output.type !== 'json') throw new Error('unreachable');
    expect(output.value).toMatchObject({
      type: 'tool-result',
      ok: true,
      data: { summary: 'Recolor the CTA' },
    });
  });

  it('defaults to denied when no approveHandoff callback is given', async () => {
    const model = handoffModel();
    const { emit } = collectEmit();

    await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'ship it' }],
      model,
      instructions: 'You are a design agent.',
      dispatch: fakeContent().dispatch,
      emit,
      tools: fakeSessionTools(),
      // no approveHandoff — background.ts always passes one, but the loop must fail closed.
    });

    expect(handoffResultShownToModel(model)).toEqual({ type: 'execution-denied' });
  });
});
