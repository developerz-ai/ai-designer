import { describe, expect, it, vi } from 'vitest';
import {
  type BackendCandidate,
  createTaskBackend,
  fallbackMessage,
  pickBackend,
  routeHandoff,
  type TaskToolExecute,
  taskBackends,
  unwrap,
} from '@/mcp/backend';
import type { TaskCreateArgs, TaskStatus } from '@/mcp/handoff';

// backend unit: the Ship route's chrome-free seams — which connected server can take a `task`, which
// one a request targets, whether a ship dispatches or falls back to a report, and the MCP `task` tool
// → `TaskBackend` adapter (result-envelope unwrap included). Mirrors handoff.test.ts's fake-backend
// pattern (no chrome.*, no MCP transport).

const SERVERS = [
  { id: 'ai-dev', label: 'developerz.ai' },
  { id: 'devin', label: 'Devin' },
];

describe('taskBackends', () => {
  it('keeps only servers whose namespaced `task` tool is present in the merged ToolSet', () => {
    const candidates = taskBackends(SERVERS, ['ai-dev__task', 'ai-dev__search', 'devin__deploy']);
    expect(candidates).toEqual([
      { id: 'ai-dev', label: 'developerz.ai', taskToolName: 'ai-dev__task' },
    ]);
  });

  it('is empty when no connected server exposes a task tool', () => {
    expect(taskBackends(SERVERS, ['ai-dev__search'])).toEqual([]);
    expect(taskBackends(SERVERS, [])).toEqual([]);
  });
});

describe('pickBackend', () => {
  const candidates: BackendCandidate[] = [
    { id: 'ai-dev', label: 'developerz.ai', taskToolName: 'ai-dev__task' },
    { id: 'devin', label: 'Devin', taskToolName: 'devin__task' },
  ];

  it('picks the first candidate when no target is given', () => {
    expect(pickBackend(candidates)?.id).toBe('ai-dev');
  });

  it('matches a target by id or label, case-insensitively', () => {
    expect(pickBackend(candidates, 'devin')?.id).toBe('devin');
    expect(pickBackend(candidates, 'DEVELOPERZ.AI')?.id).toBe('ai-dev');
    expect(pickBackend(candidates, '  Devin  ')?.id).toBe('devin');
  });

  it('returns null for an unmatched target or no candidates', () => {
    expect(pickBackend(candidates, 'nope')).toBeNull();
    expect(pickBackend([], 'devin')).toBeNull();
    expect(pickBackend([])).toBeNull();
  });
});

describe('routeHandoff', () => {
  const candidates: BackendCandidate[] = [
    { id: 'ai-dev', label: 'developerz.ai', taskToolName: 'ai-dev__task' },
  ];
  const originRepoMap = { 'localhost:3000': 'acme/store' };

  it('routes to tasks when a backend + a repo mapping both exist', () => {
    const route = routeHandoff({
      url: 'http://localhost:3000/pricing',
      originRepoMap,
      candidates,
    });
    expect(route).toEqual({
      kind: 'tasks',
      repo: 'acme/store',
      backend: candidates[0],
    });
  });

  it('falls back to a report with no-backend when nothing is connected', () => {
    const route = routeHandoff({
      url: 'http://localhost:3000/pricing',
      originRepoMap,
      candidates: [],
    });
    expect(route).toEqual({ kind: 'report', reason: 'no-backend' });
  });

  it('falls back to a report with no-repo when the origin is unmapped', () => {
    const route = routeHandoff({
      url: 'https://unmapped.example/x',
      originRepoMap,
      candidates,
    });
    expect(route).toEqual({ kind: 'report', reason: 'no-repo' });
  });

  it('honors an explicit target when routing to tasks', () => {
    const two: BackendCandidate[] = [
      { id: 'ai-dev', label: 'developerz.ai', taskToolName: 'ai-dev__task' },
      { id: 'devin', label: 'Devin', taskToolName: 'devin__task' },
    ];
    const route = routeHandoff({
      url: 'http://localhost:3000/x',
      originRepoMap,
      candidates: two,
      target: 'Devin',
    });
    expect(route.kind).toBe('tasks');
    if (route.kind === 'tasks') expect(route.backend.id).toBe('devin');
  });
});

describe('fallbackMessage', () => {
  it('explains each fallback reason', () => {
    expect(fallbackMessage('no-backend')).toMatch(/no coding backend/i);
    expect(fallbackMessage('no-repo')).toMatch(/no repo/i);
  });
});

describe('unwrap', () => {
  it('returns a bare payload object as-is', () => {
    expect(unwrap({ id: 'x', status: 'queued' })).toEqual({ id: 'x', status: 'queued' });
  });

  it('reads a structuredContent envelope', () => {
    expect(unwrap({ structuredContent: { id: 'x' } })).toEqual({ id: 'x' });
  });

  it('parses JSON out of a content text envelope', () => {
    expect(
      unwrap({ content: [{ type: 'text', text: '{"status":"ci_green","prUrl":"u"}' }] }),
    ).toEqual({ status: 'ci_green', prUrl: 'u' });
  });

  it('degrades to {} for a non-object and leaves un-parseable envelopes to fail the schema', () => {
    expect(unwrap(null)).toEqual({});
    expect(unwrap(42)).toEqual({});
    // No id/status, non-JSON text → returns the outer object; the schema parse (not unwrap) rejects it.
    expect(unwrap({ content: [{ type: 'text', text: 'not json' }] })).toEqual({
      content: [{ type: 'text', text: 'not json' }],
    });
  });
});

describe('createTaskBackend', () => {
  const createArgs: TaskCreateArgs = {
    action: 'create',
    template: 'frontend_dev',
    repo: 'acme/store',
    title: 'Recolor CTA',
    spec: { source: 'developerz-designer', url: 'http://localhost:3000/x', edits: [] },
  };

  it('creates a task, forwarding the full args and parsing the handle', async () => {
    const execute = vi.fn<TaskToolExecute>(async () => ({
      id: 't1',
      status: 'queued',
      prUrl: 'https://gh/t1',
    }));
    const backend = createTaskBackend(execute);
    const handle = await backend.create(createArgs);

    expect(handle).toEqual({ id: 't1', status: { status: 'queued', prUrl: 'https://gh/t1' } });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create', repo: 'acme/store', title: 'Recolor CTA' }),
      undefined,
    );
  });

  it('creates from an MCP content envelope', async () => {
    const execute: TaskToolExecute = async () => ({
      content: [{ type: 'text', text: '{"id":"t2"}' }],
    });
    const handle = await createTaskBackend(execute).create(createArgs);
    expect(handle).toEqual({ id: 't2' });
  });

  it('throws when the backend returns no task id', async () => {
    const execute: TaskToolExecute = async () => ({ status: 'queued' });
    await expect(createTaskBackend(execute).create(createArgs)).rejects.toThrow(/task id/);
  });

  it('watches a task: calls task(action:watch), streams once, returns the terminal status', async () => {
    const execute = vi.fn<TaskToolExecute>(async () => ({
      status: 'ci_green',
      prUrl: 'https://gh/t1/pull/1',
    }));
    const seen: TaskStatus[] = [];
    const final = await createTaskBackend(execute).watch('t1', (s) => seen.push(s));

    expect(execute).toHaveBeenCalledWith({ action: 'watch', taskId: 't1' }, undefined);
    expect(seen).toEqual([{ status: 'ci_green', prUrl: 'https://gh/t1/pull/1' }]);
    expect(final).toEqual({ status: 'ci_green', prUrl: 'https://gh/t1/pull/1' });
  });

  it('reports an unknown status when the watch reply is unparseable', async () => {
    const execute: TaskToolExecute = async () => ({});
    const final = await createTaskBackend(execute).watch('t1', () => {});
    expect(final).toEqual({ status: 'unknown' });
  });
});
