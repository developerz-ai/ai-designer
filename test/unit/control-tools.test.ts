import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { type ComplexSiteDispatch, createComplexSiteTools } from '@/agent/tools/complex-site';
import {
  type ControlDispatch,
  createInteractTools,
  type NavDispatch,
} from '@/agent/tools/interact';
import { createTabsTools, type FramesDispatch, type TabsDispatch } from '@/agent/tools/tabs';
import {
  createVisionTools,
  type InspectDispatch,
  type ReadImagesDispatch,
  type ScreenshotDispatch,
} from '@/agent/tools/vision';
import { ControlTool, FramesInput, NavIntent, TabsCmd, type ToolResult } from '@/shared/messages';

// Tool-wrapper unit (interact / tabs / vision): each tool is derived 1:1 from a Zod input const —
// the tool NAME carries the `type` discriminant, the inputSchema is that const minus `type`. We
// inject fake dispatches (no chrome, no model) and assert every execute reattaches the right
// discriminant, forwards the model args INCLUDING the `Target`, threads the abort signal, and
// returns the dispatch's ToolResult verbatim.

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

// A recorder usable as any of the dispatch shapes (they all take (msg, signal) → ToolResult).
function recorder() {
  const calls: Call[] = [];
  const dispatch = async (msg: unknown, signal?: AbortSignal): Promise<ToolResult> => {
    calls.push({ msg, signal });
    return RESULT;
  };
  return { calls, dispatch };
}

describe('createInteractTools', () => {
  it('exposes the page-driving + navigation tools', () => {
    const { dispatch } = recorder();
    const names = Object.keys(
      createInteractTools({ control: dispatch as ControlDispatch, nav: dispatch as NavDispatch }),
    ).sort();
    expect(names).toEqual(
      [
        'click',
        'handleDialog',
        'hover',
        'navigate',
        'navigateBack',
        'pressKey',
        'reload',
        'scrollTo',
        'selectOption',
        'type',
        'waitFor',
      ].sort(),
    );
  });

  it('routes actions through `control` and navigation through `nav`, reattaching the discriminant', async () => {
    const control = recorder();
    const nav = recorder();
    const tools = createInteractTools({
      control: control.dispatch as ControlDispatch,
      nav: nav.dispatch as NavDispatch,
    });
    const signal = new AbortController().signal;

    const clicked = await callExecute(tools.click.execute, { selector: '#cta' }, signal);
    const clickCall = only(control.calls);
    expect(clickCall.msg).toEqual({ type: 'click', selector: '#cta' });
    expect(ControlTool.safeParse(clickCall.msg).success).toBe(true);
    expect(clickCall.signal).toBe(signal);
    expect(clicked).toBe(RESULT);

    await callExecute(tools.navigate.execute, { url: 'https://x.test/' }, signal);
    const navCall = only(nav.calls);
    expect(navCall.msg).toEqual({ type: 'navigate', url: 'https://x.test/' });
    expect(NavIntent.safeParse(navCall.msg).success).toBe(true);
  });

  it('forwards the frame/tab Target so the agent can drive an iframe / another tab', async () => {
    const control = recorder();
    const tools = createInteractTools({
      control: control.dispatch as ControlDispatch,
      nav: recorder().dispatch as NavDispatch,
    });
    await callExecute(
      tools.type.execute,
      { selector: 'input', text: 'hi', submit: true, tabId: 4, frameId: 7 },
      new AbortController().signal,
    );
    expect(only(control.calls).msg).toEqual({
      type: 'type',
      selector: 'input',
      text: 'hi',
      submit: true,
      tabId: 4,
      frameId: 7,
    });
  });

  it('drops the `type` discriminant from each inputSchema (waitFor still validates its fields)', () => {
    const tools = createInteractTools({
      control: recorder().dispatch as ControlDispatch,
      nav: recorder().dispatch as NavDispatch,
    });
    const schema = tools.waitFor.inputSchema as unknown as ZodType;
    expect(schema.safeParse({ selector: '.done', timeMs: 1000 }).success).toBe(true);
    expect(schema.safeParse({ timeMs: 99_999 }).success).toBe(false); // 30s hard cap enforced
  });
});

describe('createComplexSiteTools', () => {
  it('exposes pageFacts/readChart/chartTooltip/widgetAct, each with the ToolResult output schema', () => {
    const { dispatch } = recorder();
    const tools = createComplexSiteTools(dispatch as ComplexSiteDispatch);
    expect(Object.keys(tools).sort()).toEqual(
      ['pageFacts', 'readChart', 'chartTooltip', 'widgetAct'].sort(),
    );
    for (const t of Object.values(tools)) {
      const out = t.outputSchema as unknown as ZodType;
      expect(out.safeParse(RESULT).success).toBe(true);
    }
  });

  it('reattaches the discriminant, forwards Target, and threads the abort signal', async () => {
    const { calls, dispatch } = recorder();
    const tools = createComplexSiteTools(dispatch as ComplexSiteDispatch);
    const signal = new AbortController().signal;

    const facts = await callExecute(tools.pageFacts.execute, { tabId: 2, frameId: 1 }, signal);
    expect(calls[0]?.msg).toEqual({ type: 'pageFacts', tabId: 2, frameId: 1 });
    expect(calls[0]?.signal).toBe(signal);
    expect(facts).toBe(RESULT);

    await callExecute(tools.readChart.execute, { selector: '.chart' }, signal);
    expect(calls[1]?.msg).toEqual({ type: 'readChart', selector: '.chart' });

    await callExecute(tools.chartTooltip.execute, { selector: '.chart' }, signal);
    expect(calls[2]?.msg).toEqual({ type: 'chartTooltip', selector: '.chart' });

    const recipe = { type: 'toggle', selector: '#dark-mode', on: true };
    await callExecute(tools.widgetAct.execute, { recipe }, signal);
    expect(calls[3]?.msg).toEqual({ type: 'widgetAct', recipe });
    expect(ControlTool.safeParse(calls[3]?.msg).success).toBe(true);
  });

  it('drops the `type` discriminant from each inputSchema (readChart selector stays optional)', () => {
    const tools = createComplexSiteTools(recorder().dispatch as ComplexSiteDispatch);
    const pageFactsSchema = tools.pageFacts.inputSchema as unknown as ZodType;
    expect(pageFactsSchema.safeParse({}).success).toBe(true);
    const readChartSchema = tools.readChart.inputSchema as unknown as ZodType;
    expect(readChartSchema.safeParse({}).success).toBe(true);
    expect(readChartSchema.safeParse({ selector: '.chart' }).success).toBe(true);
  });
});

describe('createTabsTools', () => {
  it('exposes `tabs` + `frames`, each with the ToolResult output schema', () => {
    const { dispatch } = recorder();
    const tools = createTabsTools({
      tabs: dispatch as TabsDispatch,
      frames: dispatch as FramesDispatch,
    });
    expect(Object.keys(tools).sort()).toEqual(['frames', 'tabs']);
    for (const t of Object.values(tools)) {
      const out = t.outputSchema as unknown as ZodType;
      expect(out.safeParse(RESULT).success).toBe(true);
    }
  });

  it('tabs reassembles a valid TabsCmd; frames always sets action:list', async () => {
    const tabs = recorder();
    const frames = recorder();
    const tools = createTabsTools({
      tabs: tabs.dispatch as TabsDispatch,
      frames: frames.dispatch as FramesDispatch,
    });
    const signal = new AbortController().signal;

    await callExecute(tools.tabs.execute, { action: 'open', url: 'https://ref.test/' }, signal);
    const tabsCall = only(tabs.calls);
    expect(tabsCall.msg).toEqual({ type: 'tabs', action: 'open', url: 'https://ref.test/' });
    expect(TabsCmd.safeParse(tabsCall.msg).success).toBe(true);

    await callExecute(tools.frames.execute, { tabId: 3 }, signal);
    const framesCall = only(frames.calls);
    expect(framesCall.msg).toEqual({ type: 'frames', action: 'list', tabId: 3 });
    expect(FramesInput.safeParse(framesCall.msg).success).toBe(true);
  });
});

describe('createVisionTools', () => {
  function vision() {
    const screenshot = recorder();
    const readImages = recorder();
    const inspect = recorder();
    const tools = createVisionTools({
      screenshot: screenshot.dispatch as ScreenshotDispatch,
      readImages: readImages.dispatch as ReadImagesDispatch,
      inspect: inspect.dispatch as InspectDispatch,
    });
    return { screenshot, readImages, inspect, tools };
  }

  it('exposes screenshot / readImages / inspectVisually', () => {
    expect(Object.keys(vision().tools).sort()).toEqual([
      'inspectVisually',
      'readImages',
      'screenshot',
    ]);
  });

  it('screenshot forwards fullPage + Target to its dispatch', async () => {
    const v = vision();
    await callExecute(
      v.tools.screenshot.execute,
      { fullPage: true, tabId: 2 },
      new AbortController().signal,
    );
    expect(only(v.screenshot.calls).msg).toEqual({ type: 'screenshot', fullPage: true, tabId: 2 });
  });

  it('inspectVisually carries the question to the vision dispatch', async () => {
    const v = vision();
    const signal = new AbortController().signal;
    const res = await callExecute(
      v.tools.inspectVisually.execute,
      { question: 'Is the CTA readable?', selector: '#cta' },
      signal,
    );
    const call = only(v.inspect.calls);
    expect(call.msg).toEqual({
      type: 'inspectVisually',
      question: 'Is the CTA readable?',
      selector: '#cta',
    });
    expect(call.signal).toBe(signal);
    expect(res).toBe(RESULT);
  });

  it('readImages routes to its content dispatch', async () => {
    const v = vision();
    await callExecute(
      v.tools.readImages.execute,
      { selector: 'main' },
      new AbortController().signal,
    );
    expect(only(v.readImages.calls).msg).toEqual({ type: 'readImages', selector: 'main' });
  });
});
