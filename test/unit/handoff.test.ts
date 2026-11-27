import { describe, expect, it, vi } from 'vitest';
import {
  HANDOFF_SOURCE,
  originOf,
  planTasks,
  resolveOriginEntry,
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
  stylesheets: [],
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
  const map = {
    'localhost:3000': { repo: 'acme/storefront' },
    'shop.example.com': { repo: 'acme/shop' },
  };

  it('maps a page URL to its repo by origin', () => {
    expect(resolveRepo('http://localhost:3000/pricing', map)).toBe('acme/storefront');
    expect(resolveRepo('https://shop.example.com/cart', map)).toBe('acme/shop');
  });

  it('returns null for an unmapped origin or a bad URL', () => {
    expect(resolveRepo('https://unknown.com/', map)).toBeNull();
    expect(resolveRepo('not a url', map)).toBeNull();
  });
});

describe('resolveOriginEntry (#20)', () => {
  const map = {
    'localhost:3000': { repo: 'acme/storefront', backendId: 'ai-dev', branch: 'develop' },
  };

  it('returns the FULL routing entry — repo plus backendId/branch overrides', () => {
    expect(resolveOriginEntry('http://localhost:3000/pricing', map)).toEqual({
      repo: 'acme/storefront',
      backendId: 'ai-dev',
      branch: 'develop',
    });
  });

  it('returns null for an unmapped origin or a bad URL', () => {
    expect(resolveOriginEntry('https://unknown.com/', map)).toBeNull();
    expect(resolveOriginEntry('not a url', map)).toBeNull();
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

  it('attaches a stable idempotency key derived from the changeset sessionId to every spec', () => {
    const sessionId = 'a3e1c9f2-6b7d-4e8a-9c01-5f2d3b4a6e70';
    const source = (id: string): ShipSource => ({
      kind: 'changeset',
      changeset: changeset({ sessionId: id }),
    });

    // Re-planning the same session reuses the key: a retried or double Ship is one task at the
    // backend, not two that age held on a key (see docs/standards/hold-idempotency.md).
    const first = planTasks(source(sessionId), target);
    const second = planTasks(source(sessionId), target);
    expect(first).toHaveLength(1);
    expect(first[0]?.spec.idempotencyKey?.startsWith(`${sessionId}:`)).toBe(true);
    expect(second[0]?.spec.idempotencyKey).toBe(first[0]?.spec.idempotencyKey);

    // A different session must get a different key.
    const differentSessionId = 'b3e1c9f2-6b7d-4e8a-9c01-5f2d3b4a6e70';
    const other = planTasks(source(differentSessionId), target);
    expect(other[0]?.spec.idempotencyKey?.startsWith(`${differentSessionId}:`)).toBe(true);
    expect(other[0]?.spec.idempotencyKey).not.toBe(first[0]?.spec.idempotencyKey);

    // Fan-out tasks have distinct session-derived keys, stable for the same report.
    const fanned = planTasks(
      {
        kind: 'report',
        report: report(),
        changeset: changeset({ sessionId }),
        multiTask: true,
      },
      target,
    );
    expect(fanned).toHaveLength(2);
    const fannedKeys = fanned.map((s) => s.spec.idempotencyKey);
    expect(fannedKeys.every((key) => key?.startsWith(`${sessionId}:`))).toBe(true);
    expect(new Set(fannedKeys).size).toBe(2);

    // A report with no changeset has no session identity — no key, still a valid task.
    const keyless = planTasks({ kind: 'report', report: report() }, target);
    expect(keyless[0]?.spec.idempotencyKey).toBeUndefined();
    expect(keyless[0]?.spec.brief).toContain('# Design review');
  });

  it('threads target.branch into the changeset task’s spec (#20)', () => {
    const [spec] = planTasks(
      { kind: 'changeset', changeset: changeset() },
      { repo: 'acme/storefront', branch: 'develop' },
    );
    expect(spec?.spec.branch).toBe('develop');
  });

  it('threads target.branch into a single-report task’s spec (#20)', () => {
    const [spec] = planTasks(
      { kind: 'report', report: report() },
      { repo: 'acme/storefront', branch: 'develop' },
    );
    expect(spec?.spec.branch).toBe('develop');
  });

  it('threads target.branch into EVERY multi-task spec (#20)', () => {
    const specs = planTasks(
      { kind: 'report', report: report(), multiTask: true },
      { repo: 'acme/storefront', branch: 'develop' },
    );
    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.spec.branch)).toEqual(['develop', 'develop']);
  });

  it('omits the branch KEY entirely when the target names none', () => {
    const [cs] = planTasks({ kind: 'changeset', changeset: changeset() }, target);
    expect(cs && 'branch' in cs.spec).toBe(false);
    const [rp] = planTasks({ kind: 'report', report: report() }, target);
    expect(rp && 'branch' in rp.spec).toBe(false);
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

  it('creates distinct fan-out tasks and reuses their IDs on retry with a deduplicating backend', async () => {
    const ids = new Map<string, string>();
    const backend: TaskBackend = {
      create: vi.fn(async ({ idempotencyKey }) => {
        if (!idempotencyKey) throw new Error('missing idempotency key');
        let id = ids.get(idempotencyKey);
        if (!id) {
          id = `task-${ids.size + 1}`;
          ids.set(idempotencyKey, id);
        }
        return { id };
      }),
      watch: vi.fn(async () => ({ status: 'ci_green' })),
    };
    const source: ShipSource = {
      kind: 'report',
      report: report(),
      changeset: changeset(),
      multiTask: true,
    };
    const first = await ship(source, target, { backend });
    const retry = await ship(source, target, { backend });
    const firstIds = first.tasks.map((task) => task.taskId);
    expect(firstIds).toHaveLength(2);
    expect(firstIds.every(Boolean)).toBe(true);
    expect(new Set(firstIds).size).toBe(2);
    expect(retry.tasks.map((task) => task.taskId)).toEqual(firstIds);
    expect(ids.size).toBe(2);
  });

  // The key is the SESSION plus WHAT is dispatched. A session outlives a Ship — the user keeps
  // designing in the same chat and ships again — so a session-only key dedupes that second Ship onto
  // the first task at the backend and the new edits are silently never dispatched.
  function dedupingBackend(): { backend: TaskBackend; keys: Map<string, string> } {
    const keys = new Map<string, string>();
    const backend: TaskBackend = {
      create: vi.fn(async ({ idempotencyKey }) => {
        if (!idempotencyKey) throw new Error('missing idempotency key');
        let id = keys.get(idempotencyKey);
        if (!id) {
          id = `task-${keys.size + 1}`;
          keys.set(idempotencyKey, id);
        }
        return { id };
      }),
      watch: vi.fn(async () => ({ status: 'ci_green' })),
    };
    return { backend, keys };
  }

  it('opens a NEW task when the same session ships again with more edits', async () => {
    const { backend } = dedupingBackend();
    const firstShip = await ship({ kind: 'changeset', changeset: changeset() }, target, {
      backend,
    });
    const grown = changeset({ edits: [edit(), edit({ intent: 'Tighten the nav' })] });
    const secondShip = await ship({ kind: 'changeset', changeset: grown }, target, { backend });
    expect(secondShip.tasks[0]?.taskId).not.toBe(firstShip.tasks[0]?.taskId);
  });

  it('opens a NEW task when the work changes in any keyed input, at the same edit count', async () => {
    const { backend } = dedupingBackend();
    const base = await ship({ kind: 'changeset', changeset: changeset() }, target, { backend });
    const baseId = base.tasks[0]?.taskId;
    const variants: Array<[string, Changeset, { repo: string; branch?: string }]> = [
      [
        'a different edit, same count',
        changeset({ edits: [edit({ intent: 'Make the CTA green' })] }),
        target,
      ],
      ['another page', changeset({ url: 'http://localhost:3000/checkout' }), target],
      ['another repo', changeset(), { repo: 'acme/other' }],
      ['another branch', changeset(), { ...target, branch: 'develop' }],
    ];
    for (const [name, cs, where] of variants) {
      const result = await ship({ kind: 'changeset', changeset: cs }, where, { backend });
      expect(result.tasks[0]?.taskId, name).not.toBe(baseId);
    }
  });

  it('opens a NEW task when a later fan-out ships a different problem at the same position', async () => {
    const { backend } = dedupingBackend();
    const ship1 = await ship(
      {
        kind: 'report',
        report: report({ problems: ['Nav overflows at 375px'] }),
        changeset: changeset(),
        multiTask: true,
      },
      target,
      { backend },
    );
    const ship2 = await ship(
      {
        kind: 'report',
        report: report({ problems: ['CTA contrast too low'] }),
        changeset: changeset(),
        multiTask: true,
      },
      target,
      { backend },
    );
    expect(ship2.tasks[0]?.taskId).not.toBe(ship1.tasks[0]?.taskId);
  });

  it('keeps a retried report on its task even though the model re-authored the brief', async () => {
    const { backend } = dedupingBackend();
    const once = await ship(
      { kind: 'report', report: report({ summary: 'First draft.' }), changeset: changeset() },
      target,
      { backend },
    );
    const again = await ship(
      { kind: 'report', report: report({ summary: 'Second draft.' }), changeset: changeset() },
      target,
      { backend },
    );
    expect(again.tasks[0]?.taskId).toBe(once.tasks[0]?.taskId);
  });

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

  it('sends a session-scoped idempotency key on EVERY task(create) dispatch, stably across retries', async () => {
    const sessionId = 'a3e1c9f2-6b7d-4e8a-9c01-5f2d3b4a6e70';
    // All three Ship routes must carry the key: a bare changeset, an unsplit report with an
    // attached changeset, and a multi-task report fan-out. Dropping the top-level key on any
    // one of them reopens the double-Ship duplicate-task bug.
    const sources: Array<{ name: string; source: ShipSource; expected: number }> = [
      {
        name: 'bare changeset',
        source: { kind: 'changeset', changeset: changeset({ sessionId }) },
        expected: 1,
      },
      {
        name: 'unsplit report',
        source: { kind: 'report', report: report(), changeset: changeset({ sessionId }) },
        expected: 1,
      },
      {
        name: 'multi-task report',
        source: {
          kind: 'report',
          report: report(),
          changeset: changeset({ sessionId }),
          multiTask: true,
        },
        expected: 2,
      },
    ];

    for (const { name, source, expected } of sources) {
      const backend = fakeBackend();
      await ship(source, target, { backend });
      const calls = vi.mocked(backend.create).mock.calls.map(([args]) => args);
      expect(calls, name).toHaveLength(expected);
      const keys = calls.map((args) => args.spec.idempotencyKey);
      expect(new Set(keys).size, name).toBe(expected);
      for (const [index, args] of calls.entries()) {
        expect(args.action, name).toBe('create');
        expect(keys[index]?.startsWith(`${sessionId}:`), name).toBe(true);
        expect(args.idempotencyKey, name).toBe(keys[index]);
      }

      // A re-dispatch of the same session reuses the key; a different session does not.
      await ship(source, target, { backend });
      const retried = vi
        .mocked(backend.create)
        .mock.calls.slice(expected)
        .map(([args]) => args);
      expect(
        retried.map((a) => a.idempotencyKey),
        name,
      ).toEqual(keys);

      const differentSessionId = 'b3e1c9f2-6b7d-4e8a-9c01-5f2d3b4a6e70';
      const otherBackend = fakeBackend();
      const otherSource: ShipSource = {
        ...source,
        changeset: changeset({ sessionId: differentSessionId }),
      };
      await ship(otherSource, target, { backend: otherBackend });
      const other = vi.mocked(otherBackend.create).mock.calls.map(([args]) => args);
      const otherKeys = other.map((a) => a.idempotencyKey);
      expect(
        otherKeys.every((key) => key?.startsWith(`${differentSessionId}:`)),
        name,
      ).toBe(true);
      expect(
        other.map((a) => a.spec.idempotencyKey),
        name,
      ).toEqual(otherKeys);
    }
  });

  it('dispatches a keyless create when the report carries no changeset', async () => {
    const backend = fakeBackend();
    const result = await ship({ kind: 'report', report: report() }, target, { backend });
    expect(result.tasks).toHaveLength(1);
    expect(backend.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create' }),
      undefined,
    );
    const [args] = vi.mocked(backend.create).mock.calls[0] ?? [];
    expect(args?.idempotencyKey).toBeUndefined();
    expect(args?.spec.idempotencyKey).toBeUndefined();
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

// --- the brief carries the EDITS (regression guard for a bug that shipped silently) ------------
//
// `Report` (src/shared/report.ts) has no changeset field, so a brief rendered from the report alone
// is model prose — no selector, no property, no CSS. Every "export my work to hand to a coding
// agent" was shipping the work missing: `spec.edits` carried the structured deltas, but the
// human/agent-READABLE half of the handoff had none of them. `toMarkdown` takes the changeset as an
// optional second argument; these pin that every dispatch path actually passes it.

describe('the dispatched brief carries the changeset', () => {
  const source = (over: Partial<Extract<ShipSource, { kind: 'report' }>> = {}): ShipSource => ({
    kind: 'report',
    report: report(),
    changeset: changeset({ edits: [edit()] }),
    ...over,
  });

  it('renders the edits into the single-task brief', () => {
    const [spec] = planTasks(source(), { repo: 'acme/site' });
    const brief = String(spec?.spec.brief ?? '');
    expect(brief).toContain('.cta'); // the selector
    expect(brief).toContain('#f97316'); // the value that was applied
    expect(brief).toContain('Make the CTA orange'); // the intent
  });

  it('renders paste-ready CSS, not just a prose list', () => {
    const [spec] = planTasks(source(), { repo: 'acme/site' });
    const brief = String(spec?.spec.brief ?? '');
    expect(brief).toContain('## Proposed CSS');
    expect(brief).toContain('background: #f97316;');
  });

  it('renders them into EVERY task of a multi-task fan-out', () => {
    // Each per-problem task is dispatched on its own; a brief missing the edits in task 2 is just
    // as broken as one missing them in task 1.
    const specs = planTasks(
      source({
        report: report({ problems: ['Contrast too low', 'CTA is buried'] }),
        multiTask: true,
      }),
      { repo: 'acme/site' },
    );
    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      expect(String(spec.spec.brief)).toContain('.cta');
    }
  });

  it('still renders a prose-only brief when there is no changeset', () => {
    // The parameter is optional and back-compatible: no changeset ⇒ no edits section, no bare
    // heading, no throw.
    const [spec] = planTasks(source({ changeset: undefined }), { repo: 'acme/site' });
    const brief = String(spec?.spec.brief ?? '');
    expect(brief).toContain('# Design review');
    expect(brief).not.toContain('## Edits');
    expect(brief).not.toContain('## Proposed CSS');
  });
});
