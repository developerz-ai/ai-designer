import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { createDomTools, type DomDispatch } from '@/agent/tools/dom';
import { DomTool, type ToolResult } from '@/shared/messages';

// dom.ts unit: the DOM ToolSet is derived 1:1 from the DomTool schemas, and each `execute`
// is a bus round-trip to the content script. We inject a fake dispatch (no chrome.*), so
// this asserts the derivation (names, schemas) and that execute reassembles the right
// DomTool message, forwards the abort signal, and returns the content script's ToolResult.

// What the fake content script echoes back — a distinct object so we can assert execute
// returns dispatch's result verbatim (identity), not a copy.
const RESULT: ToolResult = { type: 'tool-result', ok: true, data: { echoed: true } };

type Call = { msg: DomTool; signal?: AbortSignal };

function harness() {
  const calls: Call[] = [];
  const dispatch: DomDispatch = async (msg, signal) => {
    calls.push({ msg, signal });
    return RESULT;
  };
  return { calls, tools: createDomTools(dispatch) };
}

// The real execute signature needs a full ToolExecutionOptions; this unit only exercises the
// model args + abortSignal, so drive each tool through a minimal callable.
type MinimalExecute = (
  input: Record<string, unknown>,
  opts: { abortSignal?: AbortSignal },
) => Promise<ToolResult>;

function callExecute(execute: unknown, input: Record<string, unknown>, abortSignal: AbortSignal) {
  if (typeof execute !== 'function') throw new Error('tool is missing an execute function');
  return (execute as MinimalExecute)(input, { abortSignal });
}

function only<T>(xs: T[]): T {
  const [head, ...rest] = xs;
  if (!head || rest.length > 0) throw new Error(`expected exactly one call, got ${xs.length}`);
  return head;
}

describe('createDomTools: derivation is 1:1 with the DomTool schemas', () => {
  it('exposes exactly one tool per DomTool member, keyed by its `type` discriminant', () => {
    const names = Object.keys(harness().tools).sort();
    const discriminants = DomTool.options.map((o) => o.shape.type.value).sort();

    // Same set, no extras: adding a DomTool member without a tool (or vice versa) fails here.
    expect(names).toEqual(discriminants);
  });

  it('does not admit the picker commands (kept out of DomTool)', () => {
    const names = Object.keys(harness().tools);
    expect(names).not.toContain('picker-start');
    expect(names).not.toContain('picker-stop');
  });

  it('gives every tool a non-empty description and the ToolResult output schema', () => {
    for (const [name, t] of Object.entries(harness().tools)) {
      expect(t.description, name).toBeTruthy();
      const output = t.outputSchema as unknown as ZodType;
      expect(output.safeParse(RESULT).success, name).toBe(true);
      expect(output.safeParse({ not: 'a tool result' }).success, name).toBe(false);
    }
  });

  it('derives each inputSchema by dropping the `type` discriminant (setStyle)', () => {
    const input = harness().tools.setStyle.inputSchema as unknown as ZodType;
    // The tool name carries `type`; the model supplies only the remaining fields.
    expect(input.safeParse({ selector: '#x', props: { color: 'red' } }).success).toBe(true);
    // `type` is no longer required (nor part of the model-facing shape) …
    expect(input.safeParse({ selector: '#x' }).success).toBe(false); // props still required
    // … and the rest of the schema is preserved verbatim.
    expect(input.safeParse({ selector: '#x', props: 'nope' }).success).toBe(false);
  });
});

// Each row: the tool, the model's args (no `type`), and the DomTool message execute must
// reassemble and dispatch to the content script.
const CASES = [
  { tool: 'query', input: { selector: '#hero' }, msg: { type: 'query', selector: '#hero' } },
  {
    tool: 'getStyles',
    input: { selector: '#hero' },
    msg: { type: 'getStyles', selector: '#hero' },
  },
  {
    tool: 'screenshot',
    input: { selector: '.card' },
    msg: { type: 'screenshot', selector: '.card' },
  },
  // screenshot's selector is optional — omitting it targets the viewport.
  { tool: 'screenshot', input: {}, msg: { type: 'screenshot' } },
  {
    tool: 'a11ySnapshot',
    input: { selector: 'nav' },
    msg: { type: 'a11ySnapshot', selector: 'nav' },
  },
  {
    tool: 'setStyle',
    input: { selector: '#cta', props: { 'background-color': '#f97316' } },
    msg: { type: 'setStyle', selector: '#cta', props: { 'background-color': '#f97316' } },
  },
  {
    tool: 'setText',
    input: { selector: '#cta', value: 'Buy now' },
    msg: { type: 'setText', selector: '#cta', value: 'Buy now' },
  },
  { tool: 'undo', input: {}, msg: { type: 'undo' } },
] as const;

describe('createDomTools: execute round-trips to the content script', () => {
  it.each(CASES)('$tool reassembles a valid DomTool and dispatches it', async ({
    tool,
    input,
    msg,
  }) => {
    // The expected message is itself a valid DomTool (guards the reconstruction).
    expect(DomTool.safeParse(msg).success).toBe(true);

    const { calls, tools } = harness();
    const signal = new AbortController().signal;
    const returned = await callExecute(tools[tool].execute, input, signal);

    const call = only(calls);
    expect(call.msg).toEqual(msg); // correct `type` re-attached + fields forwarded
    expect(call.signal).toBe(signal); // abort signal threaded to the bus
    expect(returned).toBe(RESULT); // execute returns the content script's ToolResult verbatim
  });
});
