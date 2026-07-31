import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { runTurn } from '@/agent/loop';
import type { DomDispatch } from '@/agent/tools/dom';
import type { SwToPanel } from '@/shared/messages';

// Integration (#165 S8): a tool that FAILS must surface on the panel stream as a failure.
//
// The shipped bug: `loop.ts` emitted `tool-call` on the AI SDK's tool-CALL part — when the model
// REQUESTS the call, before it executes — and never forwarded the settle parts (`SwToPanel` had no
// variant for them). An edit against a stale selector came back `ok: false`, the agent retried
// elsewhere, and the panel rendered a green ✓ `setStyle → .old-cta` claiming the edit had landed.
//
// Same reproduction pattern as agent-loop.test.ts: a MOCKED model (no network) driving the real
// loop against a fake content script; background.ts itself can't be imported under Vitest.

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

/** Step 1 calls setStyle on a stale selector, step 2 retries elsewhere, step 3 wraps up. */
function retryingModel(): LanguageModelV4 {
  const call = (id: string, selector: string): LanguageModelV4StreamPart => ({
    type: 'tool-call',
    toolCallId: id,
    toolName: 'setStyle',
    input: JSON.stringify({ selector, props: { 'font-size': '24px' } }),
  });
  return new MockLanguageModelV4({
    doStream: [
      stream([
        { type: 'stream-start', warnings: [] },
        call('t1', '.old-cta'),
        finish(usage(100, 10), 'tool-calls'),
      ]),
      stream([
        { type: 'stream-start', warnings: [] },
        call('t2', '.hero__cta'),
        finish(usage(100, 10), 'tool-calls'),
      ]),
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Bumped the CTA.' },
        { type: 'text-end', id: '1' },
        finish(usage(100, 10), 'stop'),
      ]),
    ],
  });
}

/** A content script where only `.hero__cta` exists — `.old-cta` is stale, as after a re-render. */
function fakeContent(): DomDispatch {
  return async (message) => {
    const selector = 'selector' in message ? message.selector : undefined;
    return selector === '.hero__cta'
      ? { type: 'tool-result', ok: true, data: { 'font-size': '24px' } }
      : { type: 'tool-result', ok: false, error: `No element matched ${String(selector)}` };
  };
}

type ToolResultEvent = Extract<SwToPanel, { type: 'tool-result' }>;
type ToolCallEvent = Extract<SwToPanel, { type: 'tool-call' }>;

describe('integration: tool outcomes reach the panel (#165 S8)', () => {
  it('emits a FAILED tool-result for the stale selector and a successful one for the retry', async () => {
    const events: SwToPanel[] = [];

    await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'make the CTA bigger' }],
      model: retryingModel(),
      instructions: 'You are a design agent.',
      dispatch: fakeContent(),
      emit: (event) => events.push(event),
    });

    const results = events.filter((e): e is ToolResultEvent => e.type === 'tool-result');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      tool: 'setStyle',
      id: 't1',
      ok: false,
      error: 'No element matched .old-cta',
    });
    expect(results[1]).toMatchObject({ tool: 'setStyle', id: 't2', ok: true });
    expect(results[1]?.error).toBeUndefined();
  });

  it('correlates each outcome with the tool-call that opened its chip', async () => {
    const events: SwToPanel[] = [];

    await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'make the CTA bigger' }],
      model: retryingModel(),
      instructions: 'You are a design agent.',
      dispatch: fakeContent(),
      emit: (event) => events.push(event),
    });

    const calls = events.filter((e): e is ToolCallEvent => e.type === 'tool-call');
    const results = events.filter((e): e is ToolResultEvent => e.type === 'tool-result');
    expect(calls.map((c) => c.id)).toEqual(['t1', 't2']);
    expect(results.map((r) => r.id)).toEqual(['t1', 't2']);
    // And each chip is opened before it is settled — the panel can render then fold.
    expect(events.indexOf(calls[0] as SwToPanel)).toBeLessThan(
      events.indexOf(results[0] as SwToPanel),
    );
  });
});
