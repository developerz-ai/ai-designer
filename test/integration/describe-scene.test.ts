import type { LanguageModel } from 'ai';
import { describe, expect, it } from 'vitest';
import { createDescribeTools } from '@/agent/tools/describe';
import { type GenerateVision, runDescribeScene } from '@/agent/vision';
import type { ToolResult } from '@/shared/messages';

// Integration: the `describe` AI-SDK tool's `scene` mode (src/agent/tools/describe.ts) wired to the
// REAL `runDescribeScene` sub-call (src/agent/vision.ts) — not a fake `scene` dispatch
// (test/unit/describe-tools.test.ts wires a bare recorder; test/unit/vision.test.ts unit-tests
// `runDescribeScene` alone). This proves the two compose exactly like vision-tool.test.ts does for
// `inspectVisually`: the tool reassembles the model's args, `runDescribeScene` captures the region
// via an injected screenshot dispatch and asks a MOCKED vision model, and the prose flows back out
// through the tool's `execute` as a typed `DescribeResult` — while `layout`/`content` modes never
// touch the vision model at all.

function callExecute(execute: unknown, input: Record<string, unknown>, signal: AbortSignal) {
  if (typeof execute !== 'function') throw new Error('tool is missing an execute function');
  return (execute as (i: unknown, o: { abortSignal?: AbortSignal }) => Promise<ToolResult>)(input, {
    abortSignal: signal,
  });
}

const MODEL = {} as LanguageModel;
const PNG = 'data:image/png;base64,AAAA';

describe('describe(mode:"scene") tool → runDescribeScene → mocked vision model → prose', () => {
  it('captures via the screenshot dispatch, asks the mocked model, and returns the prose as a DescribeResult', async () => {
    const captured: unknown[] = [];
    const asked: string[] = [];
    const generate: GenerateVision = async ({ messages }) => {
      asked.push(JSON.stringify(messages));
      return { text: 'A dark hero with a centered headline and an orange CTA on the right.' };
    };

    let describeCalls = 0;
    const tools = createDescribeTools({
      describe: async () => {
        describeCalls += 1;
        return { type: 'tool-result', ok: true, data: { mode: 'layout', text: 'unused' } };
      },
      scene: (msg, signal) =>
        runDescribeScene(
          {
            model: MODEL,
            generate,
            capture: async (input) => {
              captured.push(input);
              return { type: 'tool-result', ok: true, data: PNG };
            },
          },
          msg,
          signal,
        ),
      readImageContent: async () => ({ type: 'tool-result', ok: true, data: { description: '' } }),
    });

    const signal = new AbortController().signal;
    const result = await callExecute(
      tools.describe.execute,
      { mode: 'scene', selector: '.hero' },
      signal,
    );

    // The region was captured through the injected screenshot dispatch, scoped to the model's selector…
    expect(captured).toEqual([
      { type: 'screenshot', selector: '.hero', tabId: undefined, frameId: undefined },
    ]);
    // …the mocked model was asked, with the image in view…
    expect(asked[0]).toContain('image');
    // …and the tool's execute surfaces runDescribeScene's typed prose verbatim, never the DOM dispatch.
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      mode: 'scene',
      text: 'A dark hero with a centered headline and an orange CTA on the right.',
    });
    expect(describeCalls).toBe(0);
  });

  it('a failed capture short-circuits before the vision model is ever asked', async () => {
    const generate: GenerateVision = async () => {
      throw new Error('should not be called');
    };
    const tools = createDescribeTools({
      describe: async () => ({ type: 'tool-result', ok: true, data: { mode: 'layout', text: '' } }),
      scene: (msg, signal) =>
        runDescribeScene(
          {
            model: MODEL,
            generate,
            capture: async () => ({ type: 'tool-result', ok: false, error: 'no such element' }),
          },
          msg,
          signal,
        ),
      readImageContent: async () => ({ type: 'tool-result', ok: true, data: { description: '' } }),
    });

    const result = await callExecute(
      tools.describe.execute,
      { mode: 'scene', selector: '#missing' },
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no such element');
  });
});
