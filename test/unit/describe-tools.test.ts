import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  createDescribeTools,
  type DescribeDispatch,
  type ReadImageContentDispatch,
  type SceneDispatch,
} from '@/agent/tools/describe';
import { createIdentityTool, type IdentityDispatch } from '@/agent/tools/identity';
import {
  DescribeCmd,
  DescribeInput,
  DescribeResult,
  ExtractIdentityInput,
  IdentityResult,
  ImageDescription,
  ReadImageContentInput,
  type ToolResult,
} from '@/shared/messages';

// Tool-wrapper unit (slice 14 describe / extractIdentity / readImageContent) + schema validation.
// Each tool is derived 1:1 from a Zod input const — the tool NAME carries the `type` discriminant,
// the inputSchema is that const minus `type`. We inject fake dispatches (no chrome, no model) and
// assert every execute reattaches the right discriminant, forwards the `Target`, threads the abort
// signal, returns the ToolResult verbatim — and, for `describe`, routes `scene` to vision but the
// text modes to the cheap DOM dispatch. Mirrors control-tools.test.ts.

const RESULT: ToolResult = { type: 'tool-result', ok: true, data: { echoed: true } };

type Call = { msg: unknown; signal?: AbortSignal };
type MinimalExecute = (
  input: Record<string, unknown>,
  opts: { abortSignal?: AbortSignal },
) => Promise<ToolResult>;

function callExecute(execute: unknown, input: Record<string, unknown>, signal: AbortSignal) {
  if (typeof execute !== 'function') throw new Error('tool is missing an execute function');
  return (execute as MinimalExecute)(input, { abortSignal: signal });
}

function recorder() {
  const calls: Call[] = [];
  const dispatch = async (msg: unknown, signal?: AbortSignal): Promise<ToolResult> => {
    calls.push({ msg, signal });
    return RESULT;
  };
  return { calls, dispatch };
}

function only(calls: Call[]): Call {
  const [head, ...rest] = calls;
  if (!head || rest.length > 0) throw new Error(`expected exactly one call, got ${calls.length}`);
  return head;
}

describe('createIdentityTool', () => {
  it('exposes the extractIdentity tool with the ToolResult output schema', () => {
    const { dispatch } = recorder();
    const tools = createIdentityTool(dispatch as IdentityDispatch);
    expect(Object.keys(tools)).toEqual(['extractIdentity']);
    expect(
      (tools.extractIdentity.outputSchema as unknown as ZodType).safeParse(RESULT).success,
    ).toBe(true);
  });

  it('reattaches the discriminant, forwards the Target, threads the signal, echoes the result', async () => {
    const { calls, dispatch } = recorder();
    const tools = createIdentityTool(dispatch as IdentityDispatch);
    const signal = new AbortController().signal;

    const result = await callExecute(
      tools.extractIdentity.execute,
      { tabId: 3, frameId: 7 },
      signal,
    );
    const call = only(calls);
    expect(call.msg).toEqual({ type: 'extractIdentity', tabId: 3, frameId: 7 });
    expect(ExtractIdentityInput.safeParse(call.msg).success).toBe(true);
    expect(call.signal).toBe(signal);
    expect(result).toBe(RESULT);
  });
});

describe('createDescribeTools', () => {
  function tools() {
    const describe = recorder();
    const scene = recorder();
    const readImageContent = recorder();
    const set = createDescribeTools({
      describe: describe.dispatch as DescribeDispatch,
      scene: scene.dispatch as SceneDispatch,
      readImageContent: readImageContent.dispatch as ReadImageContentDispatch,
    });
    return { describe, scene, readImageContent, set };
  }

  it('exposes describe + readImageContent', () => {
    expect(Object.keys(tools().set).sort()).toEqual(['describe', 'readImageContent']);
  });

  it('routes a text-mode describe to the cheap content dispatch (not vision)', async () => {
    const { describe, scene, set } = tools();
    const signal = new AbortController().signal;

    const result = await callExecute(
      set.describe.execute,
      { mode: 'layout', selector: 'main' },
      signal,
    );
    const call = only(describe.calls);
    expect(call.msg).toEqual({ type: 'describe', mode: 'layout', selector: 'main' });
    expect(DescribeInput.safeParse(call.msg).success).toBe(true);
    expect(call.signal).toBe(signal);
    expect(result).toBe(RESULT);
    expect(scene.calls).toHaveLength(0); // a text ask never costs a vision call
  });

  it('routes a scene describe to the vision dispatch (not the content one)', async () => {
    const { describe, scene, set } = tools();
    await callExecute(set.describe.execute, { mode: 'scene' }, new AbortController().signal);
    expect(only(scene.calls).msg).toEqual({ type: 'describe', mode: 'scene' });
    expect(describe.calls).toHaveLength(0);
  });

  it('forwards the frame/tab Target on describe', async () => {
    const { describe, set } = tools();
    await callExecute(
      set.describe.execute,
      { mode: 'content', tabId: 4, frameId: 2 },
      new AbortController().signal,
    );
    expect(only(describe.calls).msg).toEqual({
      type: 'describe',
      mode: 'content',
      tabId: 4,
      frameId: 2,
    });
  });

  it('reassembles a valid ReadImageContentInput, threads the signal, echoes the result', async () => {
    const { readImageContent, set } = tools();
    const signal = new AbortController().signal;

    const result = await callExecute(
      set.readImageContent.execute,
      { selector: 'img.hero' },
      signal,
    );
    const call = only(readImageContent.calls);
    expect(call.msg).toEqual({ type: 'readImageContent', selector: 'img.hero' });
    expect(ReadImageContentInput.safeParse(call.msg).success).toBe(true);
    expect(call.signal).toBe(signal);
    expect(result).toBe(RESULT);
  });

  it('drops the `type` discriminant from each inputSchema', () => {
    const { set } = tools();
    const describeSchema = set.describe.inputSchema as unknown as ZodType;
    expect(describeSchema.safeParse({ mode: 'scene' }).success).toBe(true);
    expect(describeSchema.safeParse({ mode: 'nope' }).success).toBe(false); // enum enforced
    const imageSchema = set.readImageContent.inputSchema as unknown as ZodType;
    expect(imageSchema.safeParse({ selector: 'img' }).success).toBe(true);
    expect(imageSchema.safeParse({}).success).toBe(false); // selector is required
  });
});

describe('slice-14 schemas', () => {
  it('DescribeCmd accepts describe / extractIdentity / readImageContent, rejects strangers', () => {
    expect(DescribeCmd.safeParse({ type: 'describe', mode: 'layout' }).success).toBe(true);
    expect(DescribeCmd.safeParse({ type: 'extractIdentity', tabId: 1 }).success).toBe(true);
    expect(DescribeCmd.safeParse({ type: 'readImageContent', selector: 'img' }).success).toBe(true);
    expect(DescribeCmd.safeParse({ type: 'describe' }).success).toBe(false); // mode required
    expect(DescribeCmd.safeParse({ type: 'readImageContent' }).success).toBe(false); // selector required
    expect(DescribeCmd.safeParse({ type: 'unknown' }).success).toBe(false);
  });

  it('DescribeResult validates a bounded text payload', () => {
    expect(DescribeResult.safeParse({ mode: 'scene', text: 'dark hero, orange CTA' }).success).toBe(
      true,
    );
    expect(DescribeResult.safeParse({ mode: 'layout', text: 'x'.repeat(8001) }).success).toBe(
      false,
    );
  });

  it('IdentityResult validates a role-tagged palette + type scale + rhythm', () => {
    const identity = {
      palette: [{ hex: '#101010', role: 'bg', count: 12 }],
      type: { families: ['Inter'], sizes: [32, 16], weights: [400, 700] },
      spacing: [8, 16, 24],
      radius: [4, 8],
      shadows: ['0 1px 2px rgba(0, 0, 0, 0.1)'],
    };
    expect(IdentityResult.safeParse(identity).success).toBe(true);
    expect(
      IdentityResult.safeParse({ ...identity, palette: [{ hex: '#000', role: 'glow', count: 1 }] })
        .success,
    ).toBe(false); // role outside the enum
  });

  it('ImageDescription requires a description, keeps alt/src optional', () => {
    expect(
      ImageDescription.safeParse({
        selector: { value: 'img.hero', strategy: 'id', fragile: false },
        src: 'https://cdn.test/hero.png',
        alt: 'A cat',
        description: 'A tabby cat asleep on a sofa.',
      }).success,
    ).toBe(true);
    expect(ImageDescription.safeParse({ description: '' }).success).toBe(true); // alt/src optional
    expect(ImageDescription.safeParse({ alt: 'x' }).success).toBe(false); // description required
  });
});
