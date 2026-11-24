import { describe, expect, it } from 'vitest';
import {
  MAX_TOOL_RESULT_DATA_CHARS,
  MAX_TOOL_RESULT_STRING_CHARS,
  ToolResult,
} from '@/shared/messages';

// `ToolResult.data` is bounded by SIZE, never by SHAPE.
//
// The rejected alternative was a discriminated union of per-tool result schemas. It would reject an
// MCP backend's free-form JSON (third-party by definition — we cannot enumerate their shapes) and
// force every `src/dom/**` payload to be re-declared here and kept in lockstep with the content
// world forever. Size is the property that actually matters — an unbounded result pollutes the
// transcript and is re-sent on every later step — and it costs no coupling.

const parse = (data: unknown) => ToolResult.safeParse({ type: 'tool-result', ok: true, data });

describe('ToolResult.data stays shape-agnostic', () => {
  it('accepts an MCP backend’s arbitrary JSON', () => {
    expect(parse({ anything: { a: [1, 2, 3] }, nested: { deep: true } }).success).toBe(true);
  });

  it('accepts every DOM result shape without knowing any of them', () => {
    for (const data of [
      { matches: [{ value: '#a', strategy: 'id', fragile: false }], total: 1 },
      { styles: { color: 'rgb(0,0,0)' } },
      { tree: { role: 'main', name: '', children: [] } },
      { signals: [] },
      { applied: 3, failed: 0, results: [] },
    ]) {
      expect(parse(data).success, JSON.stringify(data).slice(0, 40)).toBe(true);
    }
  });

  it('accepts the absent / primitive cases', () => {
    expect(parse(undefined).success).toBe(true);
    expect(parse(null).success).toBe(true);
    expect(parse(42).success).toBe(true);
    expect(parse(true).success).toBe(true);
  });
});

describe('…but is bounded by size', () => {
  it('rejects a runaway STRUCTURED payload', () => {
    const runaway = { rows: Array.from({ length: 40_000 }, (_, i) => ({ i, v: 'x'.repeat(20) })) };
    expect(JSON.stringify(runaway).length).toBeGreaterThan(MAX_TOOL_RESULT_DATA_CHARS);
    const result = parse(runaway);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('size bound');
    }
  });

  it('accepts a structured payload at the largest honest size we have measured', () => {
    // `a11ySnapshot` on a content-heavy page ran ~22k chars. The bound sits two orders of magnitude
    // above that, so it can only fire on a genuine runaway.
    expect(parse({ tree: 'x'.repeat(22_000) }).success).toBe(true);
  });

  it('lets a screenshot through — a full-page stitch is legitimately megabytes', () => {
    // The string bound exists precisely so the vision loop is not the thing size-checking breaks.
    const png = 'A'.repeat(4_000_000);
    expect(png.length).toBeGreaterThan(MAX_TOOL_RESULT_DATA_CHARS);
    expect(parse(png).success).toBe(true);
  });

  it('still rejects a string past the runtime message ceiling', () => {
    expect(parse('A'.repeat(MAX_TOOL_RESULT_STRING_CHARS + 1)).success).toBe(false);
  });

  it('rejects an unserializable payload instead of throwing', () => {
    // A cycle could never have crossed `chrome.runtime` anyway; the schema must refuse it, not die.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parse(cyclic)).not.toThrow();
    expect(parse(cyclic).success).toBe(false);
  });
});
