import { describe, expect, it } from 'vitest';
import { diagnose } from '@/agent/diagnostics';
import type { CollectorSignal } from '@/shared/diagnostics';
import { DiagnosticsReport } from '@/shared/diagnostics';
import { ContentToSw, DiagnosticsToolResult, ToolResult } from '@/shared/messages';

// Integration: the debug engine's other half of plan 06's test list — "diagnostics events →
// aggregated report input". Unlike diagnostics.test.ts (aggregate/correlate/buildReport driven
// directly with hand-built CollectorSignal values), this proves the ACTUAL cross-world shapes
// compose: content.ts's live push (`emit({ type: 'diagnostics-signal', signal })`, one call per
// captured signal) and its pull reply to the `diagnostics` DomTool (`{ signals }` on `drain`) both
// have to round-trip the real bus schemas (`ContentToSw`, `DiagnosticsToolResult`) before
// `agent/diagnostics.ts` ever sees them — a malformed signal should never reach the engine. This
// is the SW-side wiring `ContentToSw`'s own doc comment describes ("the SW folds these into the
// turn's diagnostics buffer") and the input the report/handoff pass (PR12) will consume.

const sel = (value: string) => ({ value, strategy: 'css-path' as const, fragile: false });

// One page's worth of realistic signals, in the exact wire shape content.ts produces: a failing
// XHR, the console error it causes, an a11y violation, and a layout issue — spanning every
// category the engine grades.
const NETWORK_FAIL: CollectorSignal = {
  kind: 'network',
  method: 'GET',
  url: 'https://shop.test/api/cart?ts=1',
  ok: false,
  status: 500,
  ts: 100,
};
const RUNTIME_ERROR: CollectorSignal = {
  kind: 'console',
  level: 'error',
  text: 'Failed to load cart: request to shop.test/api/cart failed',
  ts: 101,
};
const A11Y_ISSUE: CollectorSignal = {
  kind: 'a11y',
  rule: 'control-name',
  detail: 'Button has no accessible name',
  impact: 'serious',
  selector: sel('button.icon-only'),
  ts: 102,
};
const LAYOUT_ISSUE: CollectorSignal = {
  kind: 'layout',
  rule: 'overflow-x',
  detail: 'Content overflows the viewport by 320px',
  selector: sel('main'),
  ts: 103,
};

// Wraps each raw signal the way content.ts's collector actually emits it — a `ContentToSw` push,
// one per captured signal (src/entrypoints/content.ts: `onSignal: (signal) => emit({ type:
// 'diagnostics-signal', signal })`).
function pushEvent(signal: CollectorSignal) {
  return { type: 'diagnostics-signal' as const, signal };
}

describe('diagnostics events -> aggregated report input', () => {
  it('every live-pushed signal parses as a valid ContentToSw event before it reaches the engine', () => {
    const raw = [NETWORK_FAIL, RUNTIME_ERROR, A11Y_ISSUE, LAYOUT_ISSUE].map(pushEvent);
    for (const event of raw) {
      const parsed = ContentToSw.safeParse(event);
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects a malformed push (bad discriminant / missing fields) rather than letting it reach aggregate', () => {
    expect(
      ContentToSw.safeParse({ type: 'diagnostics-signal', signal: { kind: 'console' } }).success,
    ).toBe(false);
    expect(
      ContentToSw.safeParse({ type: 'diagnostics-signl', signal: RUNTIME_ERROR }).success,
    ).toBe(false);
  });

  it('a `diagnostics` drain ToolResult round-trips through DiagnosticsToolResult before aggregation', () => {
    // What content.ts's `runDiagnostics('drain')` hands back over the DomTool bus.
    const result: ToolResult = {
      type: 'tool-result',
      ok: true,
      data: { signals: [NETWORK_FAIL, RUNTIME_ERROR, A11Y_ISSUE, LAYOUT_ISSUE] },
    };
    expect(ToolResult.safeParse(result).success).toBe(true);
    const drained = DiagnosticsToolResult.parse(result.data);
    expect(drained.signals).toHaveLength(4);

    const report = diagnose(drained.signals, 'https://shop.test/cart', '2026-07-13T00:00:00Z');
    expect(DiagnosticsReport.safeParse(report).success).toBe(true);
  });

  it('folds a stream of ContentToSw diagnostics-signal pushes into a correlated, valid report', () => {
    const events = [NETWORK_FAIL, RUNTIME_ERROR, A11Y_ISSUE, LAYOUT_ISSUE].map(pushEvent);

    // The SW's fold: parse every push through the bus schema, keep only the signal payload —
    // exactly what a per-tab diagnostics buffer accumulates as the turn runs.
    const signals = events
      .map((event) => ContentToSw.safeParse(event))
      .filter((parsed): parsed is Extract<typeof parsed, { success: true }> => parsed.success)
      .map((parsed) => parsed.data)
      .filter(
        (event): event is { type: 'diagnostics-signal'; signal: CollectorSignal } =>
          event.type === 'diagnostics-signal',
      )
      .map((event) => event.signal);
    expect(signals).toHaveLength(4);

    const report = diagnose(signals, 'https://shop.test/cart', '2026-07-13T00:00:00Z');
    const parsed = DiagnosticsReport.safeParse(report);
    expect(parsed.success).toBe(true);

    // The report input a debug-mode turn hands to the handoff/report pass (PR12): every category
    // represented, correctly summarized, and the runtime error correlated back to the network
    // failure that caused it — a diagnosis, not a lint list.
    expect(report.summary.total).toBe(4);
    expect(report.summary.byCategory).toMatchObject({ runtime: 1, network: 1, a11y: 1, layout: 1 });
    // network(500 → error) + runtime(console error → error) + a11y(serious → error) + layout(warning)
    expect(report.summary.bySeverity).toMatchObject({ error: 3, warning: 1 });

    const runtimeFinding = report.findings.find((f) => f.category === 'runtime');
    const networkFinding = report.findings.find((f) => f.category === 'network');
    expect(runtimeFinding?.relatedIds).toContain(networkFinding?.id);
    expect(runtimeFinding?.rootCause).toMatch(/failing network request/i);

    // Deterministic: re-running the fold over the same events yields the same report (content-
    // addressed ids), so a re-run doesn't fork the findings the handoff pass already showed.
    const again = diagnose(signals, 'https://shop.test/cart', '2026-07-13T00:00:00Z');
    expect(again).toEqual(report);
  });
});
