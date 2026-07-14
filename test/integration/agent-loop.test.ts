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
import type { DescribeToolDeps } from '@/agent/tools/describe';
import type { DomDispatch } from '@/agent/tools/dom';
import type { IdentityDispatch } from '@/agent/tools/identity';
import type { InteractDeps } from '@/agent/tools/interact';
import { createSessionTools } from '@/agent/tools/session';
import type { VisionToolDeps } from '@/agent/tools/vision';
import { ChangesetStore } from '@/changeset/store';
import { emptyChangeset } from '@/shared/changeset';
import type { ControlTool, DescribeInput, DomTool, NavIntent, SwToPanel } from '@/shared/messages';

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
    expect(outcome.usage).toEqual({
      steps: 2,
      tokens: 1240,
      visionCalls: 0,
      waitCalls: 0,
      navCalls: 0,
    });
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

// Slice 13: `interact`/`tabsFrames`/`vision` are optional RunTurnArgs deps the loop turns into
// tools (`buildTools`), with `waitFor`/`navigate*`/`inspectVisually` wrapped by the turn's
// per-tool budget guards (src/agent/budget.ts `spendWait`/`spendNav`/`spendVision`) — a cap
// exceeded fails just that call with an error ToolResult instead of ending the turn.

function fakeInteract() {
  const calls: ControlTool[] = [];
  const navCalls: NavIntent[] = [];
  const deps: InteractDeps = {
    control: async (msg) => {
      calls.push(msg);
      return { type: 'tool-result', ok: true, data: {} };
    },
    nav: async (msg) => {
      navCalls.push(msg);
      return { type: 'tool-result', ok: true, data: { url: 'https://example.com/' } };
    },
  };
  return { calls, navCalls, deps };
}

function fakeVision() {
  const inspectCalls: unknown[] = [];
  const deps: VisionToolDeps = {
    screenshot: async () => ({ type: 'tool-result', ok: true, data: 'iVBORw0KGgo=' }),
    readImages: async () => ({ type: 'tool-result', ok: true, data: { images: [] } }),
    inspect: async (msg) => {
      inspectCalls.push(msg);
      return { type: 'tool-result', ok: true, data: { verdict: 'looks fine' } };
    },
  };
  return { inspectCalls, deps };
}

// A model that calls the same `toolName`/`input` on each of `n` steps, then wraps up on step
// `n + 1` — models a (possibly budget-refused) tool being retried across several turns of the loop.
function repeatedToolCallModel(toolName: string, input: unknown, n: number): MockLanguageModelV4 {
  const steps: LanguageModelV4StreamPart[][] = [];
  for (let i = 0; i < n; i += 1) {
    steps.push([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: `t${i}`, toolName, input: JSON.stringify(input) },
      finish(usage(50, 10), 'tool-calls'),
    ]);
  }
  steps.push([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'x' },
    { type: 'text-delta', id: 'x', delta: 'Done.' },
    { type: 'text-end', id: 'x' },
    finish(usage(50, 10), 'stop'),
  ]);
  return new MockLanguageModelV4({ doStream: steps.map((s) => stream(s)) });
}

// What the model was shown for the tool call made on doStream call `callIndex`.
function toolResultShownAt(
  model: MockLanguageModelV4,
  callIndex: number,
): LanguageModelV4ToolResultOutput {
  const prompt = model.doStreamCalls[callIndex]?.prompt as LanguageModelV4Prompt | undefined;
  const last = prompt?.[prompt.length - 1];
  if (last?.role !== 'tool') throw new Error('expected a tool-result message');
  const [part] = last.content;
  if (part?.type !== 'tool-result') throw new Error('expected a tool-result part');
  return part.output;
}

describe('integration: browser-control tools (interact/tabs/vision) wire in and guard their loops', () => {
  it('guards waitFor past maxWaitCalls — the refused call never reaches the dispatch', async () => {
    const { calls, deps } = fakeInteract();
    const { emit } = collectEmit();
    const model = repeatedToolCallModel('waitFor', { timeMs: 100 }, 3);

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'wait for it' }],
      model,
      instructions: 'You are a design agent.',
      dispatch: fakeContent().dispatch,
      emit,
      interact: deps,
      limits: { maxWaitCalls: 2 },
    });

    // Only the first two waitFor calls reached the injected dispatch; the third was refused.
    expect(calls.filter((c) => c.type === 'waitFor')).toHaveLength(2);
    expect(outcome.usage.waitCalls).toBe(2);

    // The model saw a guard error naming the exhausted budget on its third call.
    const third = toolResultShownAt(model, 3);
    if (third.type !== 'json') throw new Error('unreachable');
    expect(third.value).toMatchObject({ ok: false });
    expect(JSON.stringify(third.value)).toMatch(/budget/i);
  });

  it('guards navigate/navigateBack/reload past maxNavCalls, independently of waitFor', async () => {
    const { navCalls, deps } = fakeInteract();
    const { emit } = collectEmit();
    const model = repeatedToolCallModel('navigate', { url: 'https://example.com/' }, 2);

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'go there' }],
      model,
      instructions: 'You are a design agent.',
      dispatch: fakeContent().dispatch,
      emit,
      interact: deps,
      limits: { maxNavCalls: 1 },
    });

    expect(navCalls).toHaveLength(1);
    expect(outcome.usage.navCalls).toBe(1);
    const second = toolResultShownAt(model, 2);
    if (second.type !== 'json') throw new Error('unreachable');
    expect(second.value).toMatchObject({ ok: false });
  });

  it('guards inspectVisually past maxVisionCalls — a vision round-trip invisible to step/token usage', async () => {
    const { inspectCalls, deps } = fakeVision();
    const { emit } = collectEmit();
    const model = repeatedToolCallModel('inspectVisually', { question: 'is it centered?' }, 2);

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'check it' }],
      model,
      instructions: 'You are a design agent.',
      dispatch: fakeContent().dispatch,
      emit,
      vision: deps,
      limits: { maxVisionCalls: 1 },
    });

    expect(inspectCalls).toHaveLength(1);
    expect(outcome.usage.visionCalls).toBe(1);
    const second = toolResultShownAt(model, 2);
    if (second.type !== 'json') throw new Error('unreachable');
    expect(second.value).toMatchObject({ ok: false });
  });

  it('does not offer interact/tabsFrames/vision tools when their deps are omitted', async () => {
    const { emit } = collectEmit();
    // A model that immediately wraps up — proves a plain turn with none of the slice-13 deps
    // still runs fine (they're optional, matching `browse`).
    const model = new MockLanguageModelV4({
      doStream: [
        stream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'No page-driving needed here.' },
          { type: 'text-end', id: '1' },
          finish(usage(10, 5), 'stop'),
        ]),
      ],
    });

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'hi' }],
      model,
      instructions: 'You are a design agent.',
      dispatch: fakeContent().dispatch,
      emit,
    });

    expect(outcome.stop).toBe('done');
    expect(outcome.usage).toMatchObject({ waitCalls: 0, navCalls: 0, visionCalls: 0 });
  });
});

// Slice 14: `identity`/`describe` are optional RunTurnArgs deps (mirroring `vision`) that the loop
// turns into the `extractIdentity`/`describe`/`readImageContent` tools — copy mode leans on
// `extractIdentity` first, and `describe`'s `scene` mode is the one leg that must route to a
// distinct (costlier) dispatch than its cheap `layout`/`content` DOM path.

function fakeIdentity() {
  const calls: unknown[] = [];
  const dispatch: IdentityDispatch = async (input) => {
    calls.push(input);
    return {
      type: 'tool-result',
      ok: true,
      data: {
        palette: [{ hex: '#f97316', role: 'accent', count: 3 }],
        type: { families: ['Inter'], sizes: [16], weights: [400] },
        spacing: [8],
        radius: [4],
        shadows: [],
      },
    };
  };
  return { calls, dispatch };
}

function fakeDescribe() {
  const textCalls: DescribeInput[] = [];
  const sceneCalls: DescribeInput[] = [];
  const deps: DescribeToolDeps = {
    describe: async (input) => {
      textCalls.push(input);
      return { type: 'tool-result', ok: true, data: { mode: input.mode, text: 'nav/hero/footer' } };
    },
    scene: async (input) => {
      sceneCalls.push(input);
      return {
        type: 'tool-result',
        ok: true,
        data: { mode: 'scene', text: 'dark hero, orange CTA' },
      };
    },
    readImageContent: async () => ({
      type: 'tool-result',
      ok: true,
      data: { description: 'a logo' },
    }),
  };
  return { textCalls, sceneCalls, deps };
}

describe('integration: identity/describe tools (slice 14) wire in and route scene separately', () => {
  it('offers extractIdentity and routes the call to the injected identity dispatch', async () => {
    const { calls, dispatch } = fakeIdentity();
    const { emit } = collectEmit();
    const model = repeatedToolCallModel('extractIdentity', {}, 1);

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'copy nvidia.com' }],
      model,
      instructions: 'You are a design agent.',
      dispatch: fakeContent().dispatch,
      emit,
      identity: dispatch,
    });

    expect(calls).toEqual([{ type: 'extractIdentity' }]);
    expect(outcome.stop).toBe('done');
  });

  it('routes describe layout/content to the cheap dispatch and scene to the vision dispatch', async () => {
    const { textCalls, sceneCalls, deps } = fakeDescribe();
    const { emit } = collectEmit();
    const model = new MockLanguageModelV4({
      doStream: [
        stream([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 't1',
            toolName: 'describe',
            input: JSON.stringify({ mode: 'layout' }),
          },
          finish(usage(50, 10), 'tool-calls'),
        ]),
        stream([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 't2',
            toolName: 'describe',
            input: JSON.stringify({ mode: 'scene' }),
          },
          finish(usage(50, 10), 'tool-calls'),
        ]),
        stream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'x' },
          { type: 'text-delta', id: 'x', delta: 'Done.' },
          { type: 'text-end', id: 'x' },
          finish(usage(50, 10), 'stop'),
        ]),
      ],
    });

    await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'describe this page' }],
      model,
      instructions: 'You are a design agent.',
      dispatch: fakeContent().dispatch,
      emit,
      describe: deps,
    });

    expect(textCalls).toEqual([{ type: 'describe', mode: 'layout' }]);
    expect(sceneCalls).toEqual([{ type: 'describe', mode: 'scene' }]);
  });

  it('does not offer extractIdentity/describe/readImageContent when their deps are omitted', async () => {
    const { emit } = collectEmit();
    const model = new MockLanguageModelV4({
      doStream: [
        stream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'No identity/describe tools needed here.' },
          { type: 'text-end', id: '1' },
          finish(usage(10, 5), 'stop'),
        ]),
      ],
    });

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'hi' }],
      model,
      instructions: 'You are a design agent.',
      dispatch: fakeContent().dispatch,
      emit,
    });

    expect(outcome.stop).toBe('done');
  });
});
