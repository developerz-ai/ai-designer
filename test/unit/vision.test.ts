import type { LanguageModel, ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  derivePass,
  type GenerateVision,
  type InspectDeps,
  inspectPrompt,
  runInspect,
} from '@/agent/vision';
import type { InspectVisuallyInput, InspectVisuallyResult, ToolResult } from '@/shared/messages';

// vision unit: the `inspectVisually` sub-call — capture a region, ask the vision model, distill a
// verdict. Chrome-free + model-free: we inject a fake capture + a fake generate, so this asserts the
// image is handed to the model, the verdict/pass are shaped, and failures degrade to error results.

const MODEL = {} as LanguageModel;
const PNG = 'data:image/png;base64,AAAA';
const okShot = (data: string): ToolResult => ({ type: 'tool-result', ok: true, data });

function harness(over: Partial<InspectDeps> = {}) {
  const generated: Array<{ messages: ModelMessage[] }> = [];
  const generate: GenerateVision = async ({ messages }) => {
    generated.push({ messages });
    return { text: 'YES — the CTA stands out against the hero.' };
  };
  const deps: InspectDeps = {
    model: MODEL,
    capture: async () => okShot(PNG),
    generate,
    ...over,
  };
  return { generated, deps };
}

const input = (over: Partial<InspectVisuallyInput> = {}): InspectVisuallyInput => ({
  type: 'inspectVisually',
  question: 'Does the CTA have enough contrast?',
  ...over,
});

describe('runInspect', () => {
  it('captures, asks the model with the image, and returns the verdict + pass', async () => {
    const { generated, deps } = harness();
    const res = await runInspect(deps, input());
    expect(res.ok).toBe(true);
    const data = res.data as InspectVisuallyResult;
    expect(data.verdict).toContain('CTA stands out');
    expect(data.pass).toBe(true);

    // The captured PNG is handed to the model as an image content part, with the question.
    const [call] = generated;
    if (!call) throw new Error('model was not called');
    const [msg] = call.messages;
    expect(msg?.role).toBe('user');
    expect(msg?.content).toContainEqual({ type: 'image', image: PNG });
    expect(JSON.stringify(msg?.content)).toContain('contrast');
  });

  it('does not call the model when the capture fails', async () => {
    const { generated, deps } = harness({
      capture: async () => ({ type: 'tool-result', ok: false, error: 'no such element' }),
    });
    const res = await runInspect(deps, input({ selector: '#missing' }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no such element');
    expect(generated).toHaveLength(0);
  });

  it('degrades a model error to an error ToolResult', async () => {
    const { deps } = harness({
      generate: async () => {
        throw new Error('402 payment required');
      },
    });
    const res = await runInspect(deps, input());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('402');
  });

  it('omits `pass` when the model does not lead with YES/NO', async () => {
    const { deps } = harness({ generate: async () => ({ text: 'It depends on the theme.' }) });
    const res = await runInspect(deps, input());
    expect(res.ok).toBe(true);
    expect((res.data as InspectVisuallyResult).pass).toBeUndefined();
  });
});

describe('derivePass', () => {
  it.each([
    ['YES, clearly.', true],
    ['no — too faint', false],
    ['Yes.', true],
    ['NO', false],
  ])('reads a leading verdict: %s', (verdict, expected) => {
    expect(derivePass(verdict)).toBe(expected);
  });

  it.each([
    'It depends.',
    'Not sure — the contrast is borderline.',
    'Yellowish text on white.',
  ])('stays undefined on hedged / boundary-adjacent prose: %s', (verdict) => {
    expect(derivePass(verdict)).toBeUndefined();
  });
});

describe('inspectPrompt', () => {
  it('embeds the question and asks for a YES/NO lead', () => {
    const p = inspectPrompt('Is the hero image cropped?');
    expect(p).toContain('Is the hero image cropped?');
    expect(p).toMatch(/YES or NO/);
  });
});
