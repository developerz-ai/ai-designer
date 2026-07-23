import { describe, expect, it, vi } from 'vitest';
import {
  HANDOFF_SOURCE,
  originOf,
  planTasks,
  resolveRepo,
  type ShipSource,
  ship,
  TASK_TEMPLATE,
  type TaskBackend,
  type TaskStatusUpdate,
} from '@/mcp/handoff';
import type { Changeset, Edit } from '@/shared/changeset';
import type { Report } from '@/shared/report';

// mcp/handoff unit: origin→repo resolution, the changeset/report → `task(create)` planning
// (including the multi-task fan-out), and `ship`'s create+watch orchestration against a FAKE backend
// (no chrome.*, no MCP transport) — the same injected-seam pattern as `agent/report`'s fake model.

const edit = (over: Partial<Edit> = {}): Edit => ({
  intent: 'Make the CTA orange',
  selector: { value: '.cta', strategy: 'css-path', fragile: false },
  changes: [{ prop: 'background', before: '#ffffff', after: '#f97316' }],
  attrs: [],
  classes: [],
  frameworkHints: [],
  ...over,
});

const changeset = (over: Partial<Changeset> = {}): Changeset => ({
  url: 'http://localhost:3000/pricing',
  createdAt: '2026-07-14T00:00:00.000Z',
  sessionId: '00000000-0000-0000-0000-000000000000',
  edits: [edit()],
  ...over,
});

const report = (over: Partial<Report> = {}): Report => ({
  summary: 'Pricing hero refresh.',
  findings: [],
  problems: ['Nav overflows at 375px', 'CTA contrast too low'],
  pros: [],
  cons: [],
  recommendations: [],
  identity: { colors: [], fonts: [], spacing: [] },
  links: [{ label: 'Edited page', url: 'http://localhost:3000/pricing' }],
  images: [],
  ...over,
});

describe('originOf', () => {
  it('reduces a URL to its lowercased host:port', () => {
    expect(originOf('http://localhost:3000/pricing?x=1')).toBe('localhost:3000');
    expect(originOf('https://Shop.EXAMPLE.com/a/b')).toBe('shop.example.com');
  });

  it('returns null for an unparseable URL', () => {
    expect(originOf('not a url')).toBeNull();
    expect(originOf('')).toBeNull();
  });
});

describe('resolveRepo', () => {
  const map = { 'localhost:3000': 'acme/storefront', 'shop.example.com': 'acme/shop' };

  it('maps a page URL to its repo by origin', () => {
    expect(resolveRepo('http://localhost:3000/pricing', map)).toBe('acme/storefront');
    expect(resolveRepo('https://shop.example.com/cart', map)).toBe('acme/shop');
  });

  it('returns null for an unmapped origin or a bad URL', () => {
    expect(resolveRepo('https://unknown.com/', map)).toBeNull();
    expect(resolveRepo('not a url', map)).toBeNull();
  });
});

describe('planTasks', () => {
  const target = { repo: 'acme/storefront' };

  it('plans one task from a changeset, titled by the first edit intent', () => {
    const [spec, ...rest] = planTasks({ kind: 'changeset', changeset: changeset() }, target);
    expect(rest).toHaveLength(0);
    expect(spec).toBeDefined();
    expect(spec?.template).toBe(TASK_TEMPLATE);
    expect(spec?.repo).toBe('acme/storefront');
    expect(spec?.title).toBe('Make the CTA orange');
    expect(spec?.spec.source).toBe(HANDOFF_SOURCE);
    expect(spec?.spec.url).toBe('http://localhost:3000/pricing');
    expect(spec?.spec.edits).toHaveLength(1);
    expect(spec?.spec.brief).toBeUndefined();
  });

  it('honors an explicit title override', () => {
    const [spec] = planTasks(
      { kind: 'changeset', changeset: changeset(), title: 'Custom' },
      target,
    );
    expect(spec?.title).toBe('Custom');
  });

  it('refuses an empty changeset and a missing repo', () => {
    expect(() =>
      planTasks({ kind: 'changeset', changeset: changeset({ edits: [] }) }, target),
    ).toThrow(/no edits/);
    expect(() => planTasks({ kind: 'changeset', changeset: changeset() }, { repo: '  ' })).toThrow(
      /no repo/,
    );
  });

  it('plans one task from a report, briefed from the summary', () => {
    const specs = planTasks({ kind: 'report', report: report() }, target);
    expect(specs).toHaveLength(1);
    const spec = specs[0];
    expect(spec?.title).toBe('Pricing hero refresh.');
    expect(spec?.spec.problem).toBeUndefined();
    expect(spec?.spec.brief).toContain('# Design review');
    // Whole-report brief carries every problem.
    expect(spec?.spec.brief).toContain('Nav overflows at 375px');
    expect(spec?.spec.brief).toContain('CTA contrast too low');
    // No changeset supplied → url grounded from the report's first link.
    expect(spec?.spec.url).toBe('http://localhost:3000/pricing');
  });

  it('fans a multi-task report out to one task per problem, each focused', () => {
    const specs = planTasks({ kind: 'report', report: report(), multiTask: true }, target);
    expect(specs.map((s) => s.title)).toEqual(['Nav overflows at 375px', 'CTA contrast too low']);
    expect(specs.map((s) => s.spec.problem)).toEqual([
      'Nav overflows at 375px',
      'CTA contrast too low',
    ]);
    // Each focused brief mentions only its own problem.
    expect(specs[0]?.spec.brief).toContain('Nav overflows at 375px');
    expect(specs[0]?.spec.brief).not.toContain('CTA contrast too low');
    expect(specs[1]?.spec.brief).toContain('CTA contrast too low');
    expect(specs[1]?.spec.brief).not.toContain('Nav overflows at 375px');
  });

  it('falls back to a single task when a multi-task report has no problems', () => {
    const specs = planTasks(
      { kind: 'report', report: report({ problems: [] }), multiTask: true },
      target,
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]?.spec.problem).toBeUndefined();
  });

  it('attaches the changeset edits to a report task for source mapping', () => {
    const specs = planTasks({ kind: 'report', report: report(), changeset: changeset() }, target);
    expect(specs[0]?.spec.edits).toHaveLength(1);
    expect(specs[0]?.spec.url).toBe('http://localhost:3000/pricing');
  });
});

/** A backend that returns a queued handle, streams working→pr_open, and settles ci_green. */
function fakeBackend(): TaskBackend {
  return {
    create: vi.fn(async (args) => ({ id: `id-${args.title}`, status: { status: 'queued' } })),
    watch: vi.fn(async (taskId, onStatus) => {
      onStatus({ status: 'working' });
      onStatus({ status: 'pr_open', prUrl: `https://gh/${taskId}/pull/1` });
      return { status: 'ci_green', prUrl: `https://gh/${taskId}/pull/1` };
    }),
  };
}

describe('ship', () => {
  const target = { repo: 'acme/storefront' };

  it('creates + watches a single task and streams its status', async () => {
    const backend = fakeBackend();
    const updates: TaskStatusUpdate[] = [];
    const result = await ship({ kind: 'changeset', changeset: changeset() }, target, {
      backend,
      onStatus: (u) => updates.push(u),
    });

    expect(backend.create).toHaveBeenCalledTimes(1);
    expect(backend.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create', repo: 'acme/storefront' }),
      undefined,
    );
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.final).toEqual({
      status: 'ci_green',
      prUrl: 'https://gh/id-Make the CTA orange/pull/1',
    });
    expect(updates.map((u) => u.status)).toEqual(['queued', 'working', 'pr_open']);
    expect(updates.every((u) => u.total === 1 && u.index === 0)).toBe(true);
  });

  it('fans out a multi-task report, tracking each task independently', async () => {
    const backend = fakeBackend();
    const updates: TaskStatusUpdate[] = [];
    const result = await ship({ kind: 'report', report: report(), multiTask: true }, target, {
      backend,
      onStatus: (u) => updates.push(u),
    });

    expect(backend.create).toHaveBeenCalledTimes(2);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.map((t) => t.title)).toEqual([
      'Nav overflows at 375px',
      'CTA contrast too low',
    ]);
    expect(result.tasks.every((t) => t.final.status === 'ci_green')).toBe(true);
    // Every update is tagged with total=2 and its task's own id/title.
    expect(updates.every((u) => u.total === 2)).toBe(true);
    const navUpdates = updates.filter((u) => u.title === 'Nav overflows at 375px');
    expect(navUpdates.every((u) => u.index === 0 && u.taskId === 'id-Nav overflows at 375px')).toBe(
      true,
    );
  });

  it('isolates a per-task failure — one throw does not abort the other tasks', async () => {
    const backend: TaskBackend = {
      create: vi.fn(async (args) => {
        if (args.title.includes('contrast')) throw new Error('backend down');
        return { id: 'ok' };
      }),
      watch: vi.fn(async (_id, onStatus) => {
        onStatus({ status: 'working' });
        return { status: 'pr_open', prUrl: 'https://gh/ok/pull/1' };
      }),
    };
    const updates: TaskStatusUpdate[] = [];
    const result = await ship({ kind: 'report', report: report(), multiTask: true }, target, {
      backend,
      onStatus: (u) => updates.push(u),
    });

    expect(result.tasks[0]?.error).toBeUndefined();
    expect(result.tasks[0]?.final.status).toBe('pr_open');
    expect(result.tasks[1]?.error).toBe('backend down');
    expect(result.tasks[1]?.final.status).toBe('error');
    expect(result.tasks[1]?.taskId).toBe('');
    expect(updates).toContainEqual(
      expect.objectContaining({
        status: 'error',
        error: 'backend down',
        title: 'CTA contrast too low',
      }),
    );
  });

  it('propagates a planning failure (empty changeset) rather than dispatching', async () => {
    const backend = fakeBackend();
    const source: ShipSource = { kind: 'changeset', changeset: changeset({ edits: [] }) };
    await expect(ship(source, target, { backend })).rejects.toThrow(/no edits/);
    expect(backend.create).not.toHaveBeenCalled();
  });
});
