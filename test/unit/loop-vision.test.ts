import { describe, expect, it } from 'vitest';
import { screenshotToModelOutput } from '@/agent/loop';
import type { ToolResult } from '@/shared/messages';

// loop.ts vision hook: a successful `screenshot` ToolResult is handed to the model as a PNG
// image part (so a vision model sees its own result and self-corrects); anything else falls
// back to the default JSON text view. Pure — no SDK stream, no chrome.

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA';
const ok = (data: unknown): ToolResult => ({ type: 'tool-result', ok: true, data });

describe('screenshotToModelOutput', () => {
  it('turns a base64 PNG into an image content part the model can see', () => {
    const out = screenshotToModelOutput({ output: ok(PNG) });
    expect(out.type).toBe('content');
    if (out.type !== 'content') throw new Error('unreachable');
    expect(out.value).toContainEqual({
      type: 'file',
      data: { type: 'data', data: PNG },
      mediaType: 'image/png',
    });
    // Carries a text hint prompting the model to inspect + refine.
    expect(out.value.some((p) => p.type === 'text')).toBe(true);
  });

  it('strips a data-URL prefix down to the bare base64 the file part expects', () => {
    const out = screenshotToModelOutput({ output: ok(`data:image/png;base64,${PNG}`) });
    if (out.type !== 'content') throw new Error('expected content output');
    expect(out.value).toContainEqual({
      type: 'file',
      data: { type: 'data', data: PNG },
      mediaType: 'image/png',
    });
  });

  it('falls back to JSON text when the capture failed', () => {
    const failed: ToolResult = { type: 'tool-result', ok: false, error: 'no element' };
    const out = screenshotToModelOutput({ output: failed });
    expect(out.type).toBe('text');
    if (out.type !== 'text') throw new Error('unreachable');
    expect(out.value).toContain('no element');
  });

  it('falls back to JSON text when the payload is not a base64 string', () => {
    const out = screenshotToModelOutput({ output: ok({ not: 'an image' }) });
    expect(out.type).toBe('text');
  });
});
