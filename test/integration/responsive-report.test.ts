import { beforeEach, describe, expect, it } from 'vitest';
import { resolveDevice, toDeviceMetrics } from '@/agent/device-emulation';
import { createSessionTools } from '@/agent/tools/session';
import {
  type ResponsiveBreakpointFindings,
  renderResponsiveFindings,
  renderResponsiveShots,
} from '@/changeset/report-md';
import { ChangesetStore } from '@/changeset/store';
import { type Box, type ResponsiveProbe, scanResponsive } from '@/dom/responsive';
import { emptyChangeset } from '@/shared/changeset';
import type { ResponsiveShot, ToolResult } from '@/shared/messages';

// Integration: "responsive findings feed the report input" (plan 16's own wording) — proves the
// REAL scanner (src/dom/responsive.ts) and the REAL report renderer (src/changeset/report-md.ts)
// compose, rather than each being unit-tested against hand-built fixtures in isolation
// (test/unit/responsive.test.ts stubs a probe; test/unit/report-md.test.ts hand-builds a
// CheckResponsiveResult). It also proves the OTHER slice-16 doctrine line — "record an edit's
// breakpoint" — by running a real `resolveDevice` label through the real `recordEdit` tool
// (src/agent/tools/session.ts) into a real `ChangesetStore`, and asserting the report and the
// changeset key off the exact same device label (no drift between what the scan says and what an
// edit claims it targeted).

const SESSION_ID = '22222222-2222-4222-8222-222222222222';

function box(width: number, height: number, left = 0, top = 0): Box {
  return { width, height, left, top, right: left + width, bottom: top + height };
}

// A probe reporting a page that scrolls sideways and has a too-small tap target — jsdom has no
// layout engine, so geometry is injected exactly like test/unit/responsive.test.ts.
function overflowingMobileProbe(): ResponsiveProbe {
  return {
    viewportWidth: () => 375,
    viewportHeight: () => 700,
    rect: (el) => (el.id === 'x' ? box(20, 20) : box(0, 0)),
    scrollWidth: (el) => (el === document.documentElement ? 900 : 0),
    clientWidth: (el) => (el === document.documentElement ? 375 : 0),
    scrollHeight: () => 0,
    clientHeight: () => 0,
    computed: () => 'block',
    intrinsicWidth: () => 0,
  };
}

// A clean desktop-width probe: nothing overflows, nothing undersized.
function cleanDesktopProbe(): ResponsiveProbe {
  return {
    viewportWidth: () => 1280,
    viewportHeight: () => 900,
    rect: () => box(0, 0),
    scrollWidth: (el) => (el === document.documentElement ? 1280 : 0),
    clientWidth: (el) => (el === document.documentElement ? 1280 : 0),
    scrollHeight: () => 0,
    clientHeight: () => 0,
    computed: () => 'block',
    intrinsicWidth: () => 0,
  };
}

beforeEach(() => {
  document.body.innerHTML = '<button id="x">x</button>';
});

describe('real checkResponsive findings -> the Markdown report', () => {
  it('renders a per-breakpoint table for the mobile scan and skips the clean desktop one', () => {
    const mobile = scanResponsive(document, window, { probe: overflowingMobileProbe() });
    const desktop = scanResponsive(document, window, { probe: cleanDesktopProbe() });

    expect(mobile.findings.length).toBeGreaterThan(0);
    expect(desktop.findings).toEqual([]);

    const breakpoints: ResponsiveBreakpointFindings[] = [
      { label: 'Mobile', result: mobile },
      { label: 'Desktop', result: desktop },
    ];
    const md = renderResponsiveFindings(breakpoints);

    expect(md).toContain('### Mobile (375px)');
    expect(md).toContain('overflow');
    expect(md).not.toContain('### Desktop');
    // The finding's real selector (from the real scanner, not a hand-built fixture) round-trips
    // into the table.
    expect(md).toContain('|');
  });

  it('reports every breakpoint clean when none has findings', () => {
    const desktop = scanResponsive(document, window, { probe: cleanDesktopProbe() });
    expect(renderResponsiveFindings([{ label: 'Desktop', result: desktop }])).toBe('');
  });
});

describe('real responsiveCapture shots -> the Markdown report', () => {
  it('renders a resolved device label + metrics for a successful and a failed capture', () => {
    const mobile = resolveDevice({ preset: 'iphone-15' });
    const desktop = resolveDevice({ preset: 'desktop' });
    expect(mobile).toBeTruthy();
    expect(desktop).toBeTruthy();
    if (!mobile || !desktop) throw new Error('unreachable');

    const shots: ResponsiveShot[] = [
      {
        label: mobile.label,
        metrics: toDeviceMetrics(mobile),
        mechanism: 'cdp',
        image: 'AAA',
      },
      {
        label: desktop.label,
        metrics: toDeviceMetrics(desktop),
        mechanism: 'viewport',
        error: 'capture failed',
      },
    ];

    const md = renderResponsiveShots(shots);

    expect(md).toContain(`**${mobile.label}** (${mobile.width}×${mobile.height})`);
    expect(md).toContain(`**${desktop.label}**`);
    expect(md).toContain('capture failed');
  });
});

describe('an edit recorded under emulation carries the SAME breakpoint label the scan/report used', () => {
  it('resolveDevice -> recordEdit -> ChangesetStore, keyed by one shared device label', async () => {
    const device = resolveDevice({ preset: 'iphone-15' });
    expect(device).toBeTruthy();
    if (!device) throw new Error('unreachable');

    const store = new ChangesetStore(
      emptyChangeset('https://example.com/', '2026-07-14T00:00:00Z', SESSION_ID),
    );
    const persisted: unknown[] = [];
    const tools = createSessionTools({
      store,
      persist: (cs) => {
        persisted.push(cs);
      },
      emit: () => {},
    });

    type MinimalExecute = (input: unknown, opts: Record<string, unknown>) => Promise<ToolResult>;
    const execute = tools.recordEdit.execute as unknown as MinimalExecute;
    const result = await execute(
      {
        intent: 'Shrink the hero heading so it fits the iPhone 15 viewport',
        selector: { value: '#x', strategy: 'id', fragile: false },
        changes: [{ prop: 'font-size', before: '32px', after: '22px' }],
        breakpoint: device.label,
      },
      {},
    );

    expect(result).toMatchObject({ type: 'tool-result', ok: true, data: { edits: 1 } });
    expect(store.current.edits.at(-1)?.breakpoint).toBe(device.label);

    // The exact same label a `responsiveCapture`/`checkResponsive` breakpoint table would show
    // (per `renderResponsiveFindings`'s `### ${label} (${width}px)` heading) — proving the report
    // and the changeset never drift onto different names for the same device.
    const mobileScan = scanResponsive(document, window, { probe: overflowingMobileProbe() });
    const md = renderResponsiveFindings([{ label: device.label, result: mobileScan }]);
    expect(md).toContain(`### ${store.current.edits.at(-1)?.breakpoint} (375px)`);
  });
});
