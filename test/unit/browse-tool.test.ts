import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { type BrowseDispatch, createBrowseTool } from '@/agent/tools/browse';
import { BrowseInput, type DesignRead, type ToolResult } from '@/shared/messages';

// browse.ts unit: the `browse` tool is derived 1:1 from the BrowseInput schema, and its `execute`
// is a bus round-trip to an injected dispatch (the SW's background-tab snapshot). We inject a fake
// dispatch (no chrome.*), so this asserts the derivation (name, schemas) and that execute
// reassembles the `browse` message, forwards the abort signal, and returns the SW's ToolResult.

const READ: DesignRead = {
  url: 'https://nvidia.com/',
  title: 'NVIDIA',
  palette: [{ hex: '#76b900', role: 'background', count: 12 }],
  typography: { families: ['NVIDIA Sans'], scale: [48, 16], baseSize: 16 },
  regions: [{ role: 'banner', name: '' }],
  components: [{ kind: 'link', count: 30 }],
};
const RESULT: ToolResult = { type: 'tool-result', ok: true, data: READ };

type Call = { input: BrowseInput; signal?: AbortSignal };

function harness() {
  const calls: Call[] = [];
  const dispatch: BrowseDispatch = async (input, signal) => {
    calls.push({ input, signal });
    return RESULT;
  };
  return { calls, tool: createBrowseTool(dispatch).browse };
}

type MinimalExecute = (
  input: Record<string, unknown>,
  opts: { abortSignal?: AbortSignal },
) => Promise<ToolResult>;

function callExecute(execute: unknown, input: Record<string, unknown>, abortSignal: AbortSignal) {
  if (typeof execute !== 'function') throw new Error('tool is missing an execute function');
  return (execute as MinimalExecute)(input, { abortSignal });
}

describe('createBrowseTool', () => {
  it('exposes a single `browse` tool with a description and the ToolResult output schema', () => {
    const tools = createBrowseTool(async () => RESULT);
    expect(Object.keys(tools)).toEqual(['browse']);
    const t = tools.browse;
    expect(t.description).toBeTruthy();
    const output = t.outputSchema as unknown as ZodType;
    expect(output.safeParse(RESULT).success).toBe(true);
    expect(output.safeParse({ not: 'a tool result' }).success).toBe(false);
  });

  it('derives inputSchema by dropping the `type` discriminant (url only, must be a URL)', () => {
    const input = harness().tool.inputSchema as unknown as ZodType;
    expect(input.safeParse({ url: 'https://nvidia.com' }).success).toBe(true);
    expect(input.safeParse({}).success).toBe(false); // url is required
    expect(input.safeParse({ url: 'not a url' }).success).toBe(false); // must be a URL
  });

  it('execute reassembles a valid BrowseInput, forwards the signal, returns the ToolResult', async () => {
    const { calls, tool } = harness();
    const signal = new AbortController().signal;
    const returned = await callExecute(tool.execute, { url: 'https://nvidia.com' }, signal);

    const [call, ...rest] = calls;
    if (!call || rest.length > 0) throw new Error(`expected exactly one call, got ${calls.length}`);
    expect(BrowseInput.safeParse(call.input).success).toBe(true); // guards the reconstruction
    expect(call.input).toEqual({ type: 'browse', url: 'https://nvidia.com' });
    expect(call.signal).toBe(signal); // abort signal threaded to the SW
    expect(returned).toBe(RESULT); // execute returns the SW's ToolResult verbatim
  });
});
