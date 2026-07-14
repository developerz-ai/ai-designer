import { describe, expect, it } from 'vitest';
import {
  aggregate,
  buildReport,
  confirmQuestion,
  correlate,
  type DiagnosticsDriver,
  diagnose,
  hostPath,
  investigate,
} from '@/agent/diagnostics';
import type {
  CollectorSignal,
  Evidence,
  Finding,
  ReproStep,
  StableSelector,
} from '@/shared/diagnostics';

// diagnostics.ts unit: the SW debug engine. aggregate (observe/hypothesize), correlate (link a
// runtime error to its causing request), investigate (reproduce→capture→confirm via an injected
// driver — no chrome.*), and buildReport (report input for PR12). Pure logic, deterministic ids.

const sel = (value: string): StableSelector => ({ value, strategy: 'css-path', fragile: false });

const consoleErr = (text: string, ts = 1): CollectorSignal => ({
  kind: 'console',
  level: 'error',
  text,
  ts,
});

describe('aggregate', () => {
  it('collapses identical signals into one finding with an occurrence count', () => {
    const findings = aggregate([consoleErr('Boom happened', 1), consoleErr('Boom happened', 2)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.occurrences).toBe(2);
    expect(findings[0]?.category).toBe('runtime');
  });

  it('normalizes line:col and long numbers so shifting positions still merge', () => {
    const findings = aggregate([
      consoleErr('TypeError at app.js:12:5', 1),
      consoleErr('TypeError at app.js:44:9', 2),
    ]);
    expect(findings).toHaveLength(1);
  });

  it('keeps distinct signals as separate findings', () => {
    const findings = aggregate([consoleErr('A', 1), consoleErr('B', 2)]);
    expect(findings).toHaveLength(2);
  });

  it('gives the same signals the same content-addressed id every run', () => {
    const a = aggregate([consoleErr('stable', 1)]);
    const b = aggregate([consoleErr('stable', 9)]);
    expect(a[0]?.id).toBe(b[0]?.id);
  });

  it('grades severity per signal kind', () => {
    const findings = aggregate([
      { kind: 'exception', message: 'x', ts: 1 },
      { kind: 'console', level: 'warn', text: 'w', ts: 1 },
      { kind: 'network', method: 'GET', url: 'https://a/500', ok: false, status: 500, ts: 1 },
      { kind: 'network', method: 'GET', url: 'https://a/404', ok: false, status: 404, ts: 1 },
      {
        kind: 'a11y',
        rule: 'control-name',
        detail: 'd',
        impact: 'serious',
        selector: sel('button'),
        ts: 1,
      },
    ]);
    expect(findings.find((f) => f.title.includes('exception'))?.severity).toBe('critical');
    expect(findings.find((f) => f.title.includes('warn'))?.severity).toBe('warning');
    expect(findings.find((f) => f.title.includes('500'))?.severity).toBe('error');
    expect(findings.find((f) => f.title.includes('404'))?.severity).toBe('warning');
    expect(findings.find((f) => f.category === 'a11y')?.severity).toBe('error'); // serious → error
  });

  it('seeds a root-cause hypothesis + heuristic fix for actionable findings', () => {
    const [net] = aggregate([
      { kind: 'network', method: 'GET', url: 'https://a/x', ok: false, failure: 'cors', ts: 1 },
    ]);
    expect(net?.rootCause).toMatch(/CORS/i);
    const [a11y] = aggregate([
      {
        kind: 'a11y',
        rule: 'control-name',
        detail: 'd',
        impact: 'serious',
        selector: sel('button'),
        ts: 1,
      },
    ]);
    expect(a11y?.proposedFix).toMatch(/accessible name/i);
    expect(a11y?.selector?.value).toBe('button');
  });
});

describe('correlate', () => {
  const signals: CollectorSignal[] = [
    {
      kind: 'network',
      method: 'GET',
      url: 'https://api.example.com/users?id=5',
      ok: false,
      status: 500,
      ts: 1,
    },
    consoleErr('GET https://api.example.com/users?id=5 500 (Internal Server Error)', 2),
  ];

  it('links a runtime error to the failing request that likely caused it (both directions)', () => {
    const findings = correlate(aggregate(signals));
    const runtime = findings.find((f) => f.category === 'runtime');
    const network = findings.find((f) => f.category === 'network');
    expect(runtime?.relatedIds).toContain(network?.id);
    expect(network?.relatedIds).toContain(runtime?.id);
    expect(runtime?.rootCause).toMatch(/failing network request/i);
  });

  it('is a no-op when nothing references a network failure', () => {
    const findings = aggregate([consoleErr('unrelated', 1)]);
    expect(correlate(findings)).toEqual(findings);
  });
});

describe('buildReport', () => {
  it('orders by severity, counts by category/severity, and validates the schema', () => {
    const findings = aggregate([
      {
        kind: 'a11y',
        rule: 'image-alt',
        detail: 'd',
        impact: 'minor',
        selector: sel('img'),
        ts: 1,
      },
      { kind: 'exception', message: 'fatal', ts: 1 },
    ]);
    const report = buildReport('https://site.test/page?x=1', '2026-07-13T00:00:00Z', findings);
    expect(report.findings[0]?.severity).toBe('critical'); // exception sorts before the minor a11y
    expect(report.summary.total).toBe(2);
    expect(report.summary.byCategory.runtime).toBe(1);
    expect(report.summary.bySeverity.critical).toBe(1);
    expect(report.generatedAt).toBe('2026-07-13T00:00:00Z');
  });
});

describe('diagnose', () => {
  it('runs observe → hypothesize → report end to end', () => {
    const report = diagnose(
      [
        { kind: 'network', method: 'GET', url: 'https://api/x', ok: false, status: 503, ts: 1 },
        consoleErr('fetch https://api/x failed', 2),
      ],
      'https://api',
      'now',
    );
    expect(report.summary.total).toBe(2);
    expect(report.findings.some((f) => f.rootCause?.includes('failing network request'))).toBe(
      true,
    );
  });
});

// --- investigate: reproduce → capture → confirm ---------------------------

const baseFinding = (over: Partial<Finding> = {}): Finding => ({
  id: 'f1',
  category: 'interaction',
  severity: 'error',
  title: 'Buy button does nothing',
  detail: 'Clicking Buy has no effect',
  status: 'observed',
  occurrences: 1,
  evidence: [],
  repro: [],
  relatedIds: [],
  ...over,
});

interface DriverLog {
  driven: ReproStep[];
  captured: number;
  confirmed: string[];
}

function fakeDriver(
  over: Partial<{
    drive: (step: ReproStep) => Promise<{ type: 'tool-result'; ok: boolean; error?: string }>;
    capture: () => Promise<Evidence[]>;
    confirm: () => Promise<{ confirmed: boolean; detail: string }>;
  }> = {},
): { driver: DiagnosticsDriver; log: DriverLog } {
  const log: DriverLog = { driven: [], captured: 0, confirmed: [] };
  const driver: DiagnosticsDriver = {
    drive: async (step) => {
      log.driven.push(step);
      return over.drive ? over.drive(step) : { type: 'tool-result', ok: true };
    },
    capture: async () => {
      log.captured += 1;
      return over.capture
        ? over.capture()
        : [{ kind: 'screenshot', detail: 'data:image/png;base64,AA' }];
    },
    confirm: async (question) => {
      log.confirmed.push(question);
      return over.confirm
        ? over.confirm()
        : { confirmed: true, detail: 'the button did not respond' };
    },
  };
  return { driver, log };
}

const repro: ReproStep[] = [{ action: 'click', selector: '#buy', note: 'click Buy' }];

describe('investigate', () => {
  it('reproduces, captures, confirms, and advances status to confirmed', async () => {
    const { driver, log } = fakeDriver();
    const out = await investigate(baseFinding(), repro, driver);
    expect(log.driven).toEqual(repro);
    expect(log.captured).toBe(1);
    expect(log.confirmed).toHaveLength(1);
    expect(out.status).toBe('confirmed');
    expect(out.repro).toEqual(repro);
    expect(out.evidence.some((e) => e.kind === 'screenshot')).toBe(true);
    expect(out.evidence.some((e) => e.detail.includes('Confirmation: reproduced'))).toBe(true);
  });

  it('rules a finding out when confirmation says it did not reproduce', async () => {
    const { driver } = fakeDriver({
      confirm: async () => ({ confirmed: false, detail: 'button worked' }),
    });
    const out = await investigate(baseFinding(), repro, driver);
    expect(out.status).toBe('ruled-out');
  });

  it('stops at a failed repro step, still captures, and skips confirmation', async () => {
    const { driver, log } = fakeDriver({
      drive: async () => ({ type: 'tool-result', ok: false, error: 'no such element' }),
    });
    const out = await investigate(baseFinding(), repro, driver);
    expect(out.status).toBe('observed');
    expect(log.captured).toBe(1);
    expect(log.confirmed).toHaveLength(0);
    expect(out.evidence.some((e) => e.detail.includes('failed: no such element'))).toBe(true);
  });

  it('returns the finding untouched when already aborted', async () => {
    const { driver, log } = fakeDriver();
    const controller = new AbortController();
    controller.abort();
    const finding = baseFinding();
    const out = await investigate(finding, repro, driver, controller.signal);
    expect(out).toEqual(finding);
    expect(log.driven).toEqual([]);
  });

  it('degrades a throwing driver method to a note, never throwing the turn', async () => {
    const { driver } = fakeDriver({
      drive: async () => {
        throw new Error('bus down');
      },
    });
    const out = await investigate(baseFinding(), repro, driver);
    expect(out.status).toBe('observed');
    expect(out.evidence.some((e) => e.detail.includes('bus down'))).toBe(true);
  });
});

describe('confirmQuestion + hostPath', () => {
  it('asks a category-appropriate confirmation question', () => {
    expect(confirmQuestion(baseFinding({ category: 'layout' }))).toMatch(/screenshot/i);
    expect(confirmQuestion(baseFinding({ category: 'runtime' }))).toMatch(/console\/network/i);
  });

  it('reduces a URL to host+path, dropping query/hash and trailing slash', () => {
    expect(hostPath('https://a.example.com/api/users/?id=5#top')).toBe('a.example.com/api/users');
    expect(hostPath('not a url')).toBe('not a url');
  });
});
