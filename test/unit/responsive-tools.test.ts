import { describe, expect, it } from 'vitest';
import { responsiveCaptureToModelOutput } from '@/agent/loop';
import {
  type CheckResponsiveDispatch,
  createResponsiveTools,
  type ResponsiveCaptureDispatch,
  type SetDeviceDispatch,
} from '@/agent/tools/responsive';
import type { ResponsiveCaptureResult, ToolResult } from '@/shared/messages';

// responsive-tools unit: each tool is derived 1:1 from a Zod input const — the tool NAME carries the
// `type` discriminant, the inputSchema is that const minus `type`. We inject fake dispatches (no
// chrome, no debugger) and assert every execute reattaches the right discriminant, forwards the model
// args INCLUDING the `Target`, threads the abort signal, and returns the dispatch's ToolResult
// verbatim. Plus: the loop's `responsiveCaptureToModelOutput` hook fans shots out as labeled images.

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

function only(calls: Call[]): Call {
  const [head, ...rest] = calls;
  if (!head || rest.length > 0) throw new Error(`expected exactly one call, got ${calls.length}`);
  return head;
}

function recorder() {
  const calls: Call[] = [];
  const dispatch = async (msg: unknown, signal?: AbortSignal): Promise<ToolResult> => {
    calls.push({ msg, signal });
    return RESULT;
  };
  return { calls, dispatch };
}

describe('createResponsiveTools', () => {
  it('exposes the three responsive tools', () => {
    const { dispatch } = recorder();
    const names = Object.keys(
      createResponsiveTools({
        setDevice: dispatch as SetDeviceDispatch,
        capture: dispatch as ResponsiveCaptureDispatch,
        check: dispatch as CheckResponsiveDispatch,
      }),
    ).sort();
    expect(names).toEqual(['checkResponsive', 'responsiveCapture', 'setDevice']);
  });

  it('setDevice reattaches its discriminant and forwards the preset + Target + signal', async () => {
    const { calls, dispatch } = recorder();
    const tools = createResponsiveTools({
      setDevice: dispatch as SetDeviceDispatch,
      capture: dispatch as ResponsiveCaptureDispatch,
      check: dispatch as CheckResponsiveDispatch,
    });
    const signal = new AbortController().signal;
    const r = await callExecute(
      tools.setDevice.execute,
      { preset: 'iphone-15', tabId: 4, frameId: 2 },
      signal,
    );
    const call = only(calls);
    expect(call.msg).toEqual({ type: 'setDevice', preset: 'iphone-15', tabId: 4, frameId: 2 });
    expect(call.signal).toBe(signal);
    expect(r).toBe(RESULT);
  });

  it('responsiveCapture forwards breakpoints + fullPage', async () => {
    const { calls, dispatch } = recorder();
    const tools = createResponsiveTools({
      setDevice: dispatch as SetDeviceDispatch,
      capture: dispatch as ResponsiveCaptureDispatch,
      check: dispatch as CheckResponsiveDispatch,
    });
    await callExecute(
      tools.responsiveCapture.execute,
      { breakpoints: [{ preset: 'iphone-se' }], fullPage: true },
      new AbortController().signal,
    );
    expect(only(calls).msg).toEqual({
      type: 'responsiveCapture',
      breakpoints: [{ preset: 'iphone-se' }],
      fullPage: true,
    });
  });

  it('checkResponsive forwards the optional selector', async () => {
    const { calls, dispatch } = recorder();
    const tools = createResponsiveTools({
      setDevice: dispatch as SetDeviceDispatch,
      capture: dispatch as ResponsiveCaptureDispatch,
      check: dispatch as CheckResponsiveDispatch,
    });
    await callExecute(
      tools.checkResponsive.execute,
      { selector: '#main' },
      new AbortController().signal,
    );
    expect(only(calls).msg).toEqual({ type: 'checkResponsive', selector: '#main' });
  });
});

describe('responsiveCaptureToModelOutput', () => {
  const shots: ResponsiveCaptureResult['shots'] = [
    {
      label: 'Mobile',
      metrics: { width: 393, height: 852, dpr: 3, touch: true, mobile: true },
      mechanism: 'cdp',
      image: 'data:image/png;base64,AAA',
    },
    {
      label: 'Tablet',
      metrics: { width: 768, height: 1024, dpr: 2, touch: true, mobile: true },
      mechanism: 'viewport',
      error: 'quota exceeded',
    },
  ];

  it('fans successful shots out as labeled image parts and captions a failed one', () => {
    const out = responsiveCaptureToModelOutput({
      output: { type: 'tool-result', ok: true, data: { shots } },
    });
    expect(out.type).toBe('content');
    if (out.type !== 'content') throw new Error('expected content output');
    // Mobile: caption + a file part carrying the stripped base64.
    expect(out.value[0]).toEqual({ type: 'text', text: 'Mobile (393×852, cdp)' });
    expect(out.value[1]).toMatchObject({ type: 'file', mediaType: 'image/png' });
    expect(out.value[1]).toMatchObject({ data: { data: 'AAA' } });
    // Tablet: no image, so an error caption only (no file part).
    expect(out.value[2]).toEqual({ type: 'text', text: 'Tablet (768×1024): quota exceeded' });
    expect(out.value.filter((p) => p.type === 'file')).toHaveLength(1);
  });

  it('falls back to JSON text when no shot has an image', () => {
    const out = responsiveCaptureToModelOutput({
      output: { type: 'tool-result', ok: true, data: { shots: [shots[1]] } },
    });
    expect(out.type).toBe('text');
  });

  it('falls back to JSON text on a failed / shapeless result', () => {
    expect(
      responsiveCaptureToModelOutput({ output: { type: 'tool-result', ok: false } }).type,
    ).toBe('text');
  });
});
