import type { LanguageModel } from 'ai';
import { describe, expect, it } from 'vitest';
import { type GenerateReport, generateReport } from '@/agent/report';
import { toMarkdown } from '@/changeset/report-md';
import { createTaskBackend, routeHandoff, type TaskToolExecute, taskBackends } from '@/mcp/backend';
import { type ShipSource, ship, type TaskStatusUpdate } from '@/mcp/handoff';
import { type Changeset, emptyChangeset } from '@/shared/changeset';
import type { IdentityResult } from '@/shared/messages';
import type { Report } from '@/shared/report';

// handoff-route integration: the SW `ship`/`send-report`/`download-report` route composed from its
// real parts — `taskBackends` + `routeHandoff` decide, the real `generateReport` (fake model, plus a
// re-extracted page `identity` — `background.ts` `reportIdentity`'s `extractIdentity` round-trip)
// authors the brief, and either `ship` fans `task(create)` out through the `createTaskBackend`
// adapter (fake `task` tool, no MCP transport) or `toMarkdown` renders a downloadable brief.
// Exercises the exact wiring `background.ts` `runHandoffRoute` performs, which is itself
// coverage-excluded.

const URL = 'http://localhost:3000/pricing';
const SESSION_ID = '00000000-0000-0000-0000-000000000000';

function changeset(): Changeset {
  return {
    ...emptyChangeset(URL, '2026-07-14T00:00:00.000Z', SESSION_ID),
    edits: [
      {
        intent: 'Recolor the CTA',
        selector: { value: '.cta', strategy: 'css-path', fragile: false },
        changes: [{ prop: 'background', before: '#fff', after: '#f97316' }],
        attrs: [],
        classes: [],
        frameworkHints: [],
      },
    ],
  };
}

const model = {} as LanguageModel;

// A fake summarization pass: authors a two-problem draft; grounded identity/links/images are merged in
// deterministically by the real `generateReport`.
const generate: GenerateReport = async () => ({
  object: {
    summary: 'Pricing hero refresh.',
    problems: ['Nav overflows at 375px', 'CTA contrast too low'],
    recommendations: ['Cap the hero image at 100% width'],
  },
});

// Stands in for `background.ts` `reportIdentity`'s re-extracted `extractIdentity` result — the real
// SW round-trips this from the content script independent of what the turn itself already did.
const identity: IdentityResult = {
  palette: [{ hex: '#f97316', role: 'accent', count: 8 }],
  type: { families: ['Inter'], sizes: [16], weights: [400] },
  spacing: [8, 16],
  radius: [],
  shadows: [],
};

const makeReport = (): Promise<Report> =>
  generateReport({ model, generate }, { changeset: changeset(), identity });

// A fake MCP `task` tool: create returns a queued handle keyed by title; watch settles ci_green with a
// PR url. Records every call so we can assert the create args + fan-out.
function fakeTaskTool(): { execute: TaskToolExecute; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const execute: TaskToolExecute = async (args) => {
    calls.push(args);
    if (args.action === 'create') return { id: `id-${String(args.title)}`, status: 'queued' };
    if (args.action === 'watch') {
      return { status: 'ci_green', prUrl: `https://gh/${String(args.taskId)}/pull/1` };
    }
    return {};
  };
  return { execute, calls };
}

const originRepoMap = { 'localhost:3000': 'acme/storefront' };

describe('ship route — connected coding backend', () => {
  const servers = [{ id: 'ai-dev', label: 'developerz.ai' }];
  const toolNames = ['ai-dev__task'];

  it('routes to tasks and fans a multi-task report out, one task(create) per problem', async () => {
    const candidates = taskBackends(servers, toolNames);
    const route = routeHandoff({ url: URL, originRepoMap, candidates });
    expect(route.kind).toBe('tasks');
    if (route.kind !== 'tasks') return;
    expect(route.repo).toBe('acme/storefront');
    expect(route.backend.id).toBe('ai-dev');

    const { execute, calls } = fakeTaskTool();
    const backend = createTaskBackend(execute);
    const updates: TaskStatusUpdate[] = [];
    const source: ShipSource = {
      kind: 'report',
      report: await makeReport(),
      changeset: changeset(),
      multiTask: true,
    };
    const result = await ship(
      source,
      { repo: route.repo, backend: route.backend.id },
      { backend, onStatus: (u) => updates.push(u) },
    );

    // One task per problem, each tracked independently to ci_green + a PR link.
    expect(result.tasks.map((t) => t.title)).toEqual([
      'Nav overflows at 375px',
      'CTA contrast too low',
    ]);
    expect(result.tasks.every((t) => t.final.status === 'ci_green' && t.final.prUrl)).toBe(true);

    // Two create + two watch calls; each create carries the task spec + a focused brief.
    const creates = calls.filter((c) => c.action === 'create');
    expect(creates).toHaveLength(2);
    expect(calls.filter((c) => c.action === 'watch')).toHaveLength(2);
    expect(creates[0]).toMatchObject({
      action: 'create',
      repo: 'acme/storefront',
      template: 'frontend_dev',
    });
    const firstSpec = creates[0]?.spec as { brief?: string; problem?: string };
    expect(firstSpec.problem).toBe('Nav overflows at 375px');
    expect(firstSpec.brief).toContain('Nav overflows at 375px');
    expect(firstSpec.brief).not.toContain('CTA contrast too low');
    // The re-extracted page identity grounds every per-problem brief's tokens table — not just
    // the model's prose.
    expect(firstSpec.brief).toContain('#f97316 (accent)');
    expect(firstSpec.brief).toContain('`Inter`');

    // Every streamed update is tagged total=2 and its own task identity.
    expect(updates.every((u) => u.total === 2)).toBe(true);
    const navUpdates = updates.filter((u) => u.title === 'Nav overflows at 375px');
    expect(navUpdates.map((u) => u.status)).toEqual(['queued', 'ci_green']);
    expect(navUpdates.every((u) => u.index === 0)).toBe(true);
  });

  it('ships a bare changeset as a single task when source is the changeset', async () => {
    const candidates = taskBackends(servers, toolNames);
    const route = routeHandoff({ url: URL, originRepoMap, candidates });
    if (route.kind !== 'tasks') throw new Error('expected tasks route');

    const { execute, calls } = fakeTaskTool();
    const result = await ship(
      { kind: 'changeset', changeset: changeset() },
      { repo: route.repo, backend: route.backend.id },
      { backend: createTaskBackend(execute) },
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.title).toBe('Recolor the CTA');
    // A changeset ship carries the edits, no authored brief.
    const spec = calls.find((c) => c.action === 'create')?.spec as {
      brief?: string;
      edits?: unknown[];
    };
    expect(spec.brief).toBeUndefined();
    expect(spec.edits).toHaveLength(1);
  });

  it('send-report target selects the named backend among several', () => {
    const two = [
      { id: 'ai-dev', label: 'developerz.ai' },
      { id: 'devin', label: 'Devin' },
    ];
    const candidates = taskBackends(two, ['ai-dev__task', 'devin__task']);
    const route = routeHandoff({ url: URL, originRepoMap, candidates, target: 'Devin' });
    expect(route.kind).toBe('tasks');
    if (route.kind === 'tasks') expect(route.backend.id).toBe('devin');
  });
});

describe('ship route — no connected backend / no repo', () => {
  it('falls back to a downloadable Markdown brief when nothing is connected', async () => {
    const candidates = taskBackends([{ id: 'ai-dev', label: 'developerz.ai' }], []);
    const route = routeHandoff({ url: URL, originRepoMap, candidates });
    expect(route).toEqual({ kind: 'report', reason: 'no-backend' });

    const markdown = toMarkdown(await makeReport());
    expect(markdown).toContain('# Design review');
    expect(markdown).toContain('Pricing hero refresh.');
    expect(markdown).toContain('Nav overflows at 375px');
    // The downloadable brief speaks in tokens even when nothing ships as a task.
    expect(markdown).toContain('## Design tokens');
    expect(markdown).toContain('#f97316 (accent)');
  });

  it('falls back to a report when the origin has no repo mapped', () => {
    const candidates = taskBackends([{ id: 'ai-dev', label: 'developerz.ai' }], ['ai-dev__task']);
    const route = routeHandoff({ url: URL, originRepoMap: {}, candidates });
    expect(route).toEqual({ kind: 'report', reason: 'no-repo' });
  });
});
