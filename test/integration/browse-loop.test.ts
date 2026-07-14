import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { runTurn } from '@/agent/loop';
import type { BrowseDispatch } from '@/agent/tools/browse';
import type { DomDispatch } from '@/agent/tools/dom';
import type { BrowseInput, DesignRead, SwToPanel } from '@/shared/messages';

// Integration: the slice-06 spine — a turn can open a reference site via the `browse` tool. The
// tool is SW-orchestrated (not a DomTool), so we inject a fake `browse` dispatch (no chrome.*)
// standing in for background.ts's background-tab snapshot, and prove the loop routes the call,
// surfaces a tool-call chip, and feeds the returned design read (or a denial) back to the model —
// the cross-world browse flow, exactly as agent-loop.test.ts reproduces the DOM-bus wiring.

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

// Step 1 calls `browse(url)`; step 2 (after seeing the design read) wraps up. Mirrors the
// mutate → observe → summarize shape of the DOM loop test.
function browseModel(url: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: `Studying ${url}. ` },
        { type: 'text-end', id: '1' },
        {
          type: 'tool-call',
          toolCallId: 'b1',
          toolName: 'browse',
          input: JSON.stringify({ url }),
        },
        finish(usage(400, 60), 'tool-calls'),
      ]),
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '2' },
        { type: 'text-delta', id: '2', delta: 'Captured its identity.' },
        { type: 'text-end', id: '2' },
        finish(usage(500, 30), 'stop'),
      ]),
    ],
  });
}

function textModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Nothing to browse.' },
        { type: 'text-end', id: '1' },
        finish(usage(100, 10), 'stop'),
      ]),
    ],
  });
}

const REF_READ: DesignRead = {
  url: 'https://nvidia.com/',
  title: 'NVIDIA',
  palette: [
    { hex: '#76b900', role: 'background', count: 12 },
    { hex: '#000000', role: 'text', count: 40 },
  ],
  typography: { families: ['NVIDIA Sans', 'Arial'], scale: [48, 32, 20, 16], baseSize: 16 },
  regions: [
    { role: 'banner', name: '' },
    { role: 'navigation', name: 'Primary' },
  ],
  components: [
    { kind: 'link', count: 30 },
    { kind: 'button', count: 6 },
  ],
};

// Fake DOM bus (unused by these cases, but runTurn requires a dispatch).
const noopDispatch: DomDispatch = async () => ({ type: 'tool-result', ok: true });

function fakeBrowse(result: Awaited<ReturnType<BrowseDispatch>>) {
  const calls: BrowseInput[] = [];
  const browse: BrowseDispatch = async (input) => {
    calls.push(input);
    return result;
  };
  return { calls, browse };
}

function collectEmit() {
  const events: SwToPanel[] = [];
  return { events, emit: (event: SwToPanel) => events.push(event) };
}

// What the model was shown for the `browse` tool-result in its second call — the loop's proof the
// design read (or the denial) actually reached the model (emit only surfaces the tool name).
function browseResultShownToModel(
  model: MockLanguageModelV4,
): LanguageModelV4ToolResultOutput | undefined {
  const prompt = model.doStreamCalls[1]?.prompt as LanguageModelV4Prompt | undefined;
  const last = prompt?.[prompt.length - 1];
  if (last?.role !== 'tool') return undefined;
  const [part] = last.content;
  return part?.type === 'tool-result' ? part.output : undefined;
}

function offeredToolNames(model: MockLanguageModelV4): string[] {
  const tools = (model.doStreamCalls[0]?.tools ?? []) as Array<{ name?: string }>;
  return tools.map((t) => t.name ?? '').filter((n) => n !== '');
}

describe('integration: the browse tool opens a reference site and feeds its design read back', () => {
  it('routes browse(url) to the injected dispatch and returns the design read to the model', async () => {
    const url = 'https://nvidia.com';
    const { calls, browse } = fakeBrowse({ type: 'tool-result', ok: true, data: REF_READ });
    const { events, emit } = collectEmit();
    const model = browseModel(url);

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'make my hero like nvidia' }],
      model,
      instructions: 'You are a design agent.',
      dispatch: noopDispatch,
      browse,
      emit,
    });

    // The call was reassembled into a valid BrowseInput and routed to the SW's browse dispatch.
    expect(calls).toEqual([{ type: 'browse', url }]);
    // A tool-call chip surfaced on the panel stream, named by the tool.
    expect(events).toContainEqual({ type: 'tool-call', tool: 'browse' });

    // The design read reached the model as the tool's JSON result — reusable in-token identity.
    const output = browseResultShownToModel(model);
    expect(output?.type).toBe('json');
    if (output?.type !== 'json') throw new Error('unreachable');
    expect(output.value).toMatchObject({ type: 'tool-result', ok: true, data: REF_READ });

    expect(outcome.stop).toBe('done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('surfaces a permission denial as an error result the model can react to', async () => {
    const denial = {
      type: 'tool-result' as const,
      ok: false,
      error: "I don't have permission to open https://nvidia.com. Grant page access, then retry.",
    };
    const { browse } = fakeBrowse(denial);
    const { emit } = collectEmit();
    const model = browseModel('https://nvidia.com');

    await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'copy nvidia' }],
      model,
      instructions: 'You are a design agent.',
      dispatch: noopDispatch,
      browse,
      emit,
    });

    // The denial is handed to the model as its browse result (not a thrown turn) so it can relay
    // it — "ask the user to grant access" — rather than the run dying.
    const output = browseResultShownToModel(model);
    expect(output?.type).toBe('json');
    if (output?.type !== 'json') throw new Error('unreachable');
    expect(output.value).toMatchObject({ type: 'tool-result', ok: false });
  });

  it('offers the browse tool only when a dispatch is injected', async () => {
    const withBrowse = browseModel('https://nvidia.com');
    await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'copy nvidia' }],
      model: withBrowse,
      instructions: 'You are a design agent.',
      dispatch: noopDispatch,
      browse: fakeBrowse({ type: 'tool-result', ok: true, data: REF_READ }).browse,
      emit: collectEmit().emit,
    });
    expect(offeredToolNames(withBrowse)).toContain('browse');

    const noBrowse = textModel();
    await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'hi' }],
      model: noBrowse,
      instructions: 'You are a design agent.',
      dispatch: noopDispatch,
      emit: collectEmit().emit,
    });
    const names = offeredToolNames(noBrowse);
    expect(names).toContain('query'); // DOM tools still offered
    expect(names).not.toContain('browse'); // …but browse isn't, with no dispatch
  });
});
