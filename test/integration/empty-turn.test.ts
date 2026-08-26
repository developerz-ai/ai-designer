import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { EMPTY_TURN_ERROR, runTurn } from '@/agent/loop';
import type { DomDispatch } from '@/agent/tools/dom';
import type { SwToPanel } from '@/shared/messages';

// Integration: "the model returned no output" as the USER meets it (GlitchTip ai-designer,
// `AI_NoOutputGeneratedError` 19 events across issues 67/75/91/93, 2026-07-31 → 2026-08-18).
//
// The SDK raises that error only when the stream carried no completed step at all. An
// OpenAI-compatible gateway that answers 200 and then closes still produces a finish chunk, so the
// step IS recorded and `streamText` reports a clean, empty finish — the turn used to return `done`
// with an empty reply and no error, and the panel showed the agent shrugging. These pin the loud
// verdict, and the second half of each pair pins what must NOT be flagged.

const usage = (input: number, output: number): LanguageModelV4Usage => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

const finish = (unified: 'stop' | 'tool-calls'): LanguageModelV4StreamPart => ({
  type: 'finish',
  usage: usage(10, 0),
  finishReason: { unified, raw: unified },
});

const dispatch: DomDispatch = async () => ({
  type: 'tool-result',
  ok: true,
  data: { color: 'red' },
});

function collectEmit() {
  const events: SwToPanel[] = [];
  return { events, emit: (event: SwToPanel) => events.push(event) };
}

const errorsOf = (events: SwToPanel[]) =>
  events
    .filter((e): e is Extract<SwToPanel, { type: 'error' }> => e.type === 'error')
    .map((e) => e.message);

/** A provider wired to a stub `fetch` — the real `@ai-sdk/openai-compatible` parsing path, so the
 *  gateway replies below are exercised exactly as they arrive over the wire in production. */
function providerAnswering(response: () => Response) {
  return createOpenAICompatible({
    name: 'test-gateway',
    baseURL: 'https://gateway.test/v1',
    apiKey: 'k',
    includeUsage: true,
    fetch: async () => response(),
  })('some-model');
}

const eventStream = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('integration: a turn that produced nothing is reported, not shrugged off', () => {
  it('flags a clean finish with no prose and no tool call', async () => {
    const { events, emit } = collectEmit();
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            finish('stop'),
          ]),
        },
      ],
    });

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'make the CTA orange' }],
      model,
      instructions: 'You are a design agent.',
      dispatch,
      emit,
    });

    expect(outcome.stop).toBe('error');
    expect(errorsOf(events)).toEqual([EMPTY_TURN_ERROR]);
  });

  // Anti-vacuity: the guard must key on "produced nothing", not on "said nothing". A turn that
  // edits the page and never narrates is the agent doing its job.
  it('does NOT flag a turn that only ran tools and never narrated', async () => {
    const { events, emit } = collectEmit();
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'edit',
              input: JSON.stringify({
                op: 'setStyle',
                intent: 'Test intent',
                selector: '#cta',
                props: { color: 'red' },
              }),
            },
            finish('tool-calls'),
          ]),
        },
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            finish('stop'),
          ]),
        },
      ],
    });

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'make the CTA orange' }],
      model,
      instructions: 'You are a design agent.',
      dispatch,
      emit,
    });

    expect(outcome.stop).toBe('done');
    expect(errorsOf(events)).toEqual([]);
  });

  // The three gateway replies that produced this in production. All answer 200 — none trips the
  // SDK's retry, and none reaches the loop's `error` stream part.
  it.each([
    ['an empty event-stream body', ''],
    ['a JSON error object served as an event stream', '{"error":{"message":"no endpoints found"}}'],
    [
      'a chunk carrying no choices',
      'data: {"id":"1","object":"chat.completion.chunk","choices":[]}\n\n',
    ],
  ])('flags %s', async (_name, body) => {
    const { events, emit } = collectEmit();

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'make the CTA orange' }],
      model: providerAnswering(() => eventStream(body)),
      instructions: 'You are a design agent.',
      dispatch,
      emit,
    });

    expect(outcome.stop).toBe('error');
    expect(errorsOf(events)).toEqual([EMPTY_TURN_ERROR]);
  });

  // Partition: a gateway that DOES stream content is untouched by the guard.
  it('leaves a gateway reply that streams real content alone', async () => {
    const { events, emit } = collectEmit();
    const body =
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Done."}}]}\n\n' +
      'data: [DONE]\n\n';

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'make the CTA orange' }],
      model: providerAnswering(() => eventStream(body)),
      instructions: 'You are a design agent.',
      dispatch,
      emit,
    });

    expect(outcome.stop).toBe('done');
    expect(outcome.text).toBe('Done.');
    expect(errorsOf(events)).toEqual([]);
  });
});
