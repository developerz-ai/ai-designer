import { describe, expect, it } from 'vitest';
import { toolOutcome } from '@/agent/loop';

// #165 S8 unit: reading a settled tool's OWN success flag off its output.
//
// Every content-routed tool reports failure as a NORMAL return carrying `{ ok: false, error }` — a
// stale selector, a denied attribute, an unreachable frame. So the SDK's `tool-result` stream part
// says only "it returned", never "it worked", and a chip rendered on the request alone shows a
// green ✓ for an edit that silently failed and was retried elsewhere.

describe('toolOutcome', () => {
  it('reads a failing ToolResult as a failure, carrying its reason', () => {
    expect(
      toolOutcome({ type: 'tool-result', ok: false, error: 'No element matched .old-cta' }),
    ).toEqual({ ok: false, error: 'No element matched .old-cta' });
  });

  it('reads a successful ToolResult as a success', () => {
    expect(toolOutcome({ type: 'tool-result', ok: true, data: { color: 'red' } })).toEqual({
      ok: true,
    });
  });

  it('omits the error field when a failure carries no reason', () => {
    expect(toolOutcome({ ok: false })).toEqual({ ok: false });
  });

  it('bounds the reason so a chip tooltip cannot become a log sink', () => {
    const outcome = toolOutcome({ ok: false, error: 'x'.repeat(2000) });
    expect(outcome.error).toHaveLength(500);
  });

  it("takes an MCP backend's free-form payload at face value — it returned, so it worked", () => {
    expect(toolOutcome({ id: 'task_1', status: 'queued' })).toEqual({ ok: true });
    expect(toolOutcome('done')).toEqual({ ok: true });
    expect(toolOutcome(undefined)).toEqual({ ok: true });
    expect(toolOutcome(null)).toEqual({ ok: true });
  });

  it('ignores a non-boolean `ok` rather than guessing', () => {
    expect(toolOutcome({ ok: 'false' })).toEqual({ ok: true });
  });
});
