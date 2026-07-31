import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { modelMessageSchema } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { runTurn } from '@/agent/loop';
import { compactForThread, IMAGE_PRUNED_PLACEHOLDER } from '@/agent/thread-compact';
import { INVALID_TOOL_NAME } from '@/agent/tool-repair';
import type { DomDispatch } from '@/agent/tools/dom';
import type { DomTool, SwToPanel } from '@/shared/messages';

// loop.ts conversation memory + tool-call robustness (#168), against a mocked model (no
// network, no chrome):
//   • `TurnOutcome.responseMessages` carries the turn's tool activity in ModelMessage shape —
//     the audited failure was that only flat prose survived a turn, so turn 2 re-ran every
//     tool (31.8k → 97.1k tokens measured). These tests FAIL against the pre-fix loop.
//   • A partial set survives a mid-turn model failure.
//   • An empty/unknown tool name or schema-invalid input becomes a recoverable error tool
//     result (live failure: `AI_NoSuchToolError` on '' killed the step).
//   • Older screenshots are pruned from later steps' prompts exactly once (prefix-stable).

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA'.repeat(20);

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

const text = (id: string, t: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: t },
  { type: 'text-end', id },
];

const start: LanguageModelV4StreamPart = { type: 'stream-start', warnings: [] };

function fakeContent() {
  const calls: DomTool[] = [];
  const dispatch: DomDispatch = async (message) => {
    calls.push(message);
    if (message.type === 'screenshot') return { type: 'tool-result', ok: true, data: PNG };
    return { type: 'tool-result', ok: true, data: { done: true } };
  };
  return { calls, dispatch };
}

function collectEmit() {
  const events: SwToPanel[] = [];
  return { events, emit: (event: SwToPanel) => events.push(event) };
}

const baseArgs = (model: LanguageModelV4, dispatch: DomDispatch, emit: (e: SwToPanel) => void) => ({
  tabId: 1,
  messages: [{ role: 'user' as const, content: 'make the CTA orange' }],
  model,
  instructions: 'You are a design agent.',
  dispatch,
  emit,
});

describe('TurnOutcome.responseMessages — the thread keeps tool activity', () => {
  const twoStepModel = () =>
    new MockLanguageModelV4({
      doStream: [
        stream([
          start,
          ...text('1', 'Making it orange. '),
          {
            type: 'tool-call',
            toolCallId: 't1',
            toolName: 'setStyle',
            input: JSON.stringify({ selector: '#cta', props: { color: 'orange' } }),
          },
          finish(usage(500, 100), 'tool-calls'),
        ]),
        stream([start, ...text('2', 'Done.'), finish(usage(600, 40), 'stop')]),
      ],
    });

  it('carries the assistant tool-call parts AND the tool results the flat text loses', async () => {
    const { dispatch } = fakeContent();
    const { emit } = collectEmit();
    const outcome = await runTurn(baseArgs(twoStepModel(), dispatch, emit));

    expect(outcome.stop).toBe('done');
    // The flat prose — all a pre-#168 thread kept — has no trace of the tool activity.
    expect(outcome.text).not.toContain('setStyle');
    expect(outcome.text).not.toContain('t1');

    // responseMessages has the full structure: assistant tool-call + tool result + final prose.
    const flat = JSON.stringify(outcome.responseMessages);
    expect(flat).toContain('"toolName":"setStyle"');
    expect(flat).toContain('"toolCallId":"t1"');
    const roles = outcome.responseMessages.map((m) => m.role);
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');
    expect(flat).toContain('Done.');
  });

  it('compacts + round-trips modelMessageSchema for persistence', async () => {
    const { dispatch } = fakeContent();
    const { emit } = collectEmit();
    const outcome = await runTurn(baseArgs(twoStepModel(), dispatch, emit));

    const compacted = compactForThread(outcome.responseMessages);
    expect(compacted.length).toBeGreaterThan(0);
    for (const message of compacted) {
      expect(modelMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it('a mid-turn model failure still returns the completed steps', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return stream([
            start,
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'query',
              input: JSON.stringify({ selector: '#cta' }),
            },
            finish(usage(300, 30), 'tool-calls'),
          ]);
        }
        throw new Error('provider fell over');
      },
    });
    const { dispatch } = fakeContent();
    const { events, emit } = collectEmit();
    const outcome = await runTurn(baseArgs(model, dispatch, emit));

    expect(outcome.stop).toBe('error');
    // Step 1 completed, so its messages survive for the session thread — the turn's work is
    // not lost with the error.
    const flat = JSON.stringify(outcome.responseMessages);
    expect(flat).toContain('"toolName":"query"');
    expect(outcome.responseMessages.some((m) => m.role === 'tool')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});

describe('broken tool calls are recoverable (#168 empty-name live failure)', () => {
  it('an EMPTY tool name becomes an error tool result naming the valid tools — the turn survives', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        stream([
          start,
          { type: 'tool-call', toolCallId: 'bad1', toolName: '', input: '{}' },
          finish(usage(300, 30), 'tool-calls'),
        ]),
        stream([start, ...text('2', 'Recovered.'), finish(usage(400, 20), 'stop')]),
      ],
    });
    const { dispatch } = fakeContent();
    const { events, emit } = collectEmit();
    const outcome = await runTurn(baseArgs(model, dispatch, emit));

    expect(outcome.stop).toBe('done');
    expect(outcome.text).toContain('Recovered.');
    expect(events.some((e) => e.type === 'error')).toBe(false);

    // The model got a readable failure naming real tools, not a dead step.
    const settle = events.find(
      (e): e is Extract<SwToPanel, { type: 'tool-result' }> =>
        e.type === 'tool-result' && e.tool === INVALID_TOOL_NAME,
    );
    expect(settle?.ok).toBe(false);
    expect(settle?.error).toContain('unavailable tool');
    expect(settle?.error).toContain('query'); // names at least one valid tool

    // And the thread records it as a well-formed call/result pair (provider-valid transcript).
    const flat = JSON.stringify(outcome.responseMessages);
    expect(flat).toContain(`"toolName":"${INVALID_TOOL_NAME}"`);
    expect(flat).toContain('"toolCallId":"bad1"');
  });

  it('schema-invalid input becomes an error tool result telling the model to re-read the schema', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        stream([
          start,
          {
            type: 'tool-call',
            toolCallId: 'bad2',
            toolName: 'setStyle',
            input: JSON.stringify({ wrong: true }),
          },
          finish(usage(300, 30), 'tool-calls'),
        ]),
        stream([start, ...text('2', 'Fixed the call.'), finish(usage(400, 20), 'stop')]),
      ],
    });
    const { calls, dispatch } = fakeContent();
    const { events, emit } = collectEmit();
    const outcome = await runTurn(baseArgs(model, dispatch, emit));

    expect(outcome.stop).toBe('done');
    expect(outcome.text).toContain('Fixed the call.');
    expect(calls).toHaveLength(0); // the invalid call never reached the page

    const settle = events.find(
      (e): e is Extract<SwToPanel, { type: 'tool-result' }> =>
        e.type === 'tool-result' && e.tool === INVALID_TOOL_NAME,
    );
    expect(settle?.ok).toBe(false);
    expect(settle?.error).toContain("'setStyle'");
    expect(settle?.error).toMatch(/schema/i);
  });
});

describe('within-turn image pruning (prepareStep wiring)', () => {
  it('replaces aged-out screenshots in later steps’ prompts, keeping the newest two', async () => {
    const shot = (id: string): LanguageModelV4StreamPart => ({
      type: 'tool-call',
      toolCallId: id,
      toolName: 'screenshot',
      input: '{}',
    });
    const model = new MockLanguageModelV4({
      doStream: [
        stream([start, shot('s1'), finish(usage(100, 10), 'tool-calls')]),
        stream([start, shot('s2'), finish(usage(100, 10), 'tool-calls')]),
        stream([start, shot('s3'), finish(usage(100, 10), 'tool-calls')]),
        stream([start, ...text('4', 'All checked.'), finish(usage(100, 10), 'stop')]),
      ],
    });
    const { dispatch } = fakeContent();
    const { emit } = collectEmit();
    const outcome = await runTurn(baseArgs(model, dispatch, emit));
    expect(outcome.stop).toBe('done');

    const prompts = model.doStreamCalls.map((call) => JSON.stringify(call.prompt));
    // Count whole payloads (PNG is internally repetitive, so a prefix match would over-count).
    const imageCount = (p: string) => p.split(PNG).length - 1;

    // Steps 1-3: at most two shots exist — nothing pruned yet.
    expect(prompts[2]).toBeDefined();
    expect(imageCount(prompts[2] ?? '')).toBe(2);
    expect(prompts[2]).not.toContain(IMAGE_PRUNED_PLACEHOLDER);

    // Step 4 sees three shots: the oldest is a placeholder, the newest two are intact.
    expect(prompts[3]).toBeDefined();
    expect(imageCount(prompts[3] ?? '')).toBe(2);
    expect(prompts[3]).toContain(IMAGE_PRUNED_PLACEHOLDER);
  });
});
