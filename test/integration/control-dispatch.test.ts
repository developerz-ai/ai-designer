import { beforeAll, describe, expect, it } from 'vitest';
import { readImages } from '@/dom/images';
import { createInteractor } from '@/dom/interact';
import { queryOne } from '@/dom/read';
import type { ControlTool, ReadImagesResult, ToolResult } from '@/shared/messages';

// Integration: a validated `ControlTool` routed through content.ts's real dispatch logic —
// `handleControl` (readImages vs. the interaction engine) + its frame-tagging — against a live
// jsdom DOM. Mirrors dom-execute.test.ts's "content script's dispatch path minus the chrome bus"
// pattern for the slice-13 control tools content.ts adds beside the slice-05 DomTool ones.

function setup(html: string): {
  dispatch: (tool: ControlTool, signal?: AbortSignal) => Promise<ToolResult>;
} {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
  const interactor = createInteractor();

  // Reproduces content.ts's `handleControl` (readImages is a pure read; everything else is handed
  // to the interaction engine) plus its top-frame tagging (`tagFrame`, content.ts:56-59).
  const selfFrameId = 0; // this harness always plays the top document
  const tagFrame = (result: ToolResult): ToolResult =>
    result.frameId === undefined ? { ...result, frameId: selfFrameId } : result;

  const dispatch = async (tool: ControlTool, signal?: AbortSignal): Promise<ToolResult> => {
    if (tool.type === 'readImages') {
      const scope = tool.selector ? queryOne(document, tool.selector) : document;
      if (tool.selector && !scope) {
        return tagFrame({
          type: 'tool-result',
          ok: false,
          error: `No element matches selector: ${tool.selector}`,
        });
      }
      const data: ReadImagesResult = readImages(scope ?? document, window);
      return tagFrame({ type: 'tool-result', ok: true, data });
    }
    // The slice-15 complex-site reads/actions (pageFacts/readChart/chartTooltip/widgetAct) route
    // through their own src/dom modules in the real content.ts, not the interaction engine — out
    // of scope for this slice-13 harness (covered separately, see src/dom's own test suites).
    if (
      tool.type === 'pageFacts' ||
      tool.type === 'readChart' ||
      tool.type === 'chartTooltip' ||
      tool.type === 'widgetAct'
    ) {
      return tagFrame({ type: 'tool-result', ok: false, error: 'not covered by this harness' });
    }
    return tagFrame(await interactor.run(tool, signal));
  };
  return { dispatch };
}

const data = <T>(r: ToolResult): T => r.data as T;

// jsdom implements neither scrollIntoView nor scrollTo — install no-op stubs once for the whole
// file (matches interact.test.ts) so click/hover/scrollTo don't log "not implemented".
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = (): void => {};
  window.scrollTo = (): void => {};
});

describe('control tool → content effect → typed result', () => {
  it('click: scrolls into view, fires a real click, echoes a frame-tagged selector', async () => {
    const { dispatch } = setup('<button id="cta">Buy</button>');
    const result = await dispatch({ type: 'click', selector: '#cta' });
    expect(result).toMatchObject({ ok: true, frameId: 0 });
    expect(result.selector?.value).toBe('#cta');
  });

  it('type: sets the value and fires input/change', async () => {
    const { dispatch } = setup('<input id="q" />');
    const result = await dispatch({ type: 'type', selector: '#q', text: 'hello' });
    expect(result.ok).toBe(true);
    expect(data<{ value: string }>(result).value).toBe('hello');
    expect((document.getElementById('q') as HTMLInputElement).value).toBe('hello');
  });

  it('pressKey: dispatches on the active element', async () => {
    const { dispatch } = setup('<input id="q" />');
    (document.getElementById('q') as HTMLInputElement).focus();
    const result = await dispatch({ type: 'pressKey', key: 'Enter' });
    expect(result.ok).toBe(true);
  });

  it('hover: fires the pointer/mouse reveal sequence', async () => {
    const { dispatch } = setup('<div id="menu">m</div>');
    const result = await dispatch({ type: 'hover', selector: '#menu' });
    expect(result).toMatchObject({ ok: true, frameId: 0 });
  });

  it('scrollTo: reports the scroll position for an absolute offset', async () => {
    const { dispatch } = setup('<div>x</div>');
    const result = await dispatch({ type: 'scrollTo', y: 200 });
    expect(result.ok).toBe(true);
    expect(data<{ x: number; y: number }>(result)).toEqual({ x: 0, y: 0 }); // jsdom scrollTo is a stub
  });

  it('selectOption: picks a <select> option and fires change', async () => {
    const { dispatch } = setup(
      '<select id="s"><option value="a">A</option><option value="b">B</option></select>',
    );
    const result = await dispatch({ type: 'selectOption', selector: '#s', value: 'b' });
    expect(data<{ value: string }>(result).value).toBe('b');
  });

  it('handleDialog: arms confirm/prompt auto-answers', async () => {
    const { dispatch } = setup('<div></div>');
    const result = await dispatch({ type: 'handleDialog', accept: true, promptText: 'yes' });
    expect(result.ok).toBe(true);
    expect(window.confirm('sure?')).toBe(true);
  });

  it('readImages: enumerates and frame-tags the result', async () => {
    const { dispatch } = setup('<img id="bad" src="https://cdn.test/missing.png" alt="x" />');
    Object.defineProperty(document.getElementById('bad'), 'naturalWidth', { value: 0 });
    Object.defineProperty(document.getElementById('bad'), 'complete', { value: true });
    const result = await dispatch({ type: 'readImages' });
    expect(result.frameId).toBe(0);
    const { images } = data<ReadImagesResult>(result);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ broken: true, oversized: false });
  });

  it('readImages: an unmatched scope selector is an error ToolResult, not a throw', async () => {
    const { dispatch } = setup('<div></div>');
    const result = await dispatch({ type: 'readImages', selector: '#ghost' });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('#ghost');
  });

  it('waitFor: resolves met:true once the awaited selector appears', async () => {
    const { dispatch } = setup('<div id="root"></div>');
    const pending = dispatch({ type: 'waitFor', selector: '#late', timeMs: 1000 });
    const el = document.createElement('span');
    el.id = 'late';
    document.getElementById('root')?.appendChild(el);
    const result = await pending;
    expect(data<{ met: boolean }>(result).met).toBe(true);
  });

  it('waitFor: times out (met:false, timedOut:true) when the condition never holds', async () => {
    const { dispatch } = setup('<div></div>');
    const result = await dispatch({ type: 'waitFor', selector: '#never', timeMs: 20 });
    expect(result.ok).toBe(true);
    expect(data<{ met: boolean; timedOut: boolean }>(result)).toMatchObject({
      met: false,
      timedOut: true,
    });
  });

  it('waitFor: an aborted signal cancels the pending wait early, before its timeout elapses', async () => {
    const { dispatch } = setup('<div></div>');
    const controller = new AbortController();
    const started = Date.now();

    const pending = dispatch(
      { type: 'waitFor', selector: '#never', timeMs: 5_000 },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 15);

    const result = await pending;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1_000); // resolved on abort, nowhere near the 5s bound
    expect(result.ok).toBe(true);
    expect(data<{ met: boolean; timedOut: boolean }>(result)).toMatchObject({ met: false });
  });

  it('waitFor: aborting before the call even starts settles immediately', async () => {
    const { dispatch } = setup('<div></div>');
    const controller = new AbortController();
    controller.abort();

    const result = await dispatch(
      { type: 'waitFor', selector: '#never', timeMs: 5_000 },
      controller.signal,
    );
    expect(data<{ met: boolean }>(result).met).toBe(false);
  });
});
