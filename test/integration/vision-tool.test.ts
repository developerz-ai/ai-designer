import type { LanguageModel } from 'ai';
import { describe, expect, it } from 'vitest';
import { createVisionTools } from '@/agent/tools/vision';
import { type GenerateVision, runInspect } from '@/agent/vision';
import type { InspectVisuallyResult, ToolResult } from '@/shared/messages';

// Integration: the `inspectVisually` AI-SDK tool (src/agent/tools/vision.ts) wired to the REAL
// `runInspect` sub-call (src/agent/vision.ts) — not a fake dispatch (test/unit/control-tools.test.ts
// wires a bare recorder; test/unit/vision.test.ts unit-tests `runInspect` alone). This proves the
// two compose: the tool reassembles the model's args, `runInspect` captures + asks a MOCKED vision
// model, and the verdict flows back out through the tool's `execute` as a typed `ToolResult`.

function callExecute(execute: unknown, input: Record<string, unknown>, signal: AbortSignal) {
  if (typeof execute !== 'function') throw new Error('tool is missing an execute function');
  return (execute as (i: unknown, o: { abortSignal?: AbortSignal }) => Promise<ToolResult>)(input, {
    abortSignal: signal,
  });
}

const MODEL = {} as LanguageModel;
const PNG = 'data:image/png;base64,AAAA';

describe('inspectVisually tool → runInspect → mocked vision model → verdict', () => {
  it('captures via the screenshot dispatch, asks the mocked model, and returns a pass verdict', async () => {
    const captured: unknown[] = [];
    const asked: string[] = [];
    const generate: GenerateVision = async ({ messages }) => {
      asked.push(JSON.stringify(messages));
      return { text: 'YES — the CTA has strong contrast against the hero.' };
    };

    const tools = createVisionTools({
      screenshot: async (msg) => {
        captured.push(msg);
        return { type: 'tool-result', ok: true, data: PNG };
      },
      readImages: async () => ({ type: 'tool-result', ok: true, data: { images: [] } }),
      inspect: (msg, signal) =>
        runInspect(
          {
            model: MODEL,
            generate,
            capture: (input, sig) =>
              callExecute(
                tools.screenshot.execute,
                { selector: input.selector, fullPage: input.fullPage },
                sig ?? new AbortController().signal,
              ),
          },
          msg,
          signal,
        ),
    });

    const signal = new AbortController().signal;
    const result = await callExecute(
      tools.inspectVisually.execute,
      { question: 'Does the CTA have enough contrast?', selector: '#cta' },
      signal,
    );

    // The region was captured through the injected screenshot dispatch …
    expect(captured).toEqual([{ type: 'screenshot', selector: '#cta', fullPage: undefined }]);
    // … the mocked model was asked, with the image + question in view …
    expect(asked[0]).toContain('contrast');
    // … and the tool's execute surfaces runInspect's typed verdict verbatim.
    expect(result.ok).toBe(true);
    const data = result.data as InspectVisuallyResult;
    expect(data.verdict).toContain('strong contrast');
    expect(data.pass).toBe(true);
  });

  it('a failed capture short-circuits before the model is ever asked', async () => {
    const generate: GenerateVision = async () => {
      throw new Error('should not be called');
    };
    const tools = createVisionTools({
      screenshot: async () => ({ type: 'tool-result', ok: false, error: 'no such element' }),
      readImages: async () => ({ type: 'tool-result', ok: true, data: { images: [] } }),
      inspect: (msg, signal) =>
        runInspect(
          {
            model: MODEL,
            generate,
            capture: (input, sig) =>
              callExecute(
                tools.screenshot.execute,
                { selector: input.selector, fullPage: input.fullPage },
                sig ?? new AbortController().signal,
              ),
          },
          msg,
          signal,
        ),
    });

    const result = await callExecute(
      tools.inspectVisually.execute,
      { question: 'Is it centered?', selector: '#missing' },
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no such element');
  });
});
