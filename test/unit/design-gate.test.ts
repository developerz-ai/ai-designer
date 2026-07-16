import { type ToolSet, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TASK_TOOL } from '@/mcp/backend';
import { designSafeTools, WRITE_TOOLS } from '@/mcp/design-gate';

// design-gate unit (#117): the pure write-tool filter applied to the design-turn merge.
// The bypass being closed: a connected backend's raw `<id>__task` tool reaching the model,
// which would dispatch a task without the user-clicked Ship.

/** A ToolSet whose keys are `names`, each a trivial static tool. */
function toolSet(...names: string[]): ToolSet {
  const set: ToolSet = {};
  for (const name of names) set[name] = tool({ description: name, inputSchema: z.object({}) });
  return set;
}

describe('designSafeTools', () => {
  it('strips the namespaced task tool of any server', () => {
    const safe = designSafeTools(toolSet('ai-dev__task', 'custom_1__task', 'ai-dev__kb'));
    expect(Object.keys(safe)).toEqual(['ai-dev__kb']);
  });

  it('keeps read tools — the #21 regression guard', () => {
    const safe = designSafeTools(toolSet('ai-dev__kb', 'ai-dev__tokens', 'ai-dev__search'));
    expect(Object.keys(safe)).toEqual(['ai-dev__kb', 'ai-dev__tokens', 'ai-dev__search']);
  });

  it('keeps a tool whose name merely contains the write verb as a substring', () => {
    // `taskforce` is not `task`; only the exact trailing segment is write-shaped.
    const safe = designSafeTools(toolSet('ai-dev__taskforce', 'ai-dev__my_task_list'));
    expect(Object.keys(safe)).toEqual(['ai-dev__taskforce', 'ai-dev__my_task_list']);
  });

  it('over-matches toward safety when a backend names a tool `*__task`', () => {
    // A sanitized server id can itself contain `__`, so the trailing segment is the only
    // reliable read — `id__my__task` is dropped rather than risking a write slipping through.
    const safe = designSafeTools(toolSet('id__my__task', 'id__my__kb'));
    expect(Object.keys(safe)).toEqual(['id__my__kb']);
  });

  it('strips a bare (un-namespaced) write name defensively', () => {
    const safe = designSafeTools(toolSet(TASK_TOOL, 'kb'));
    expect(Object.keys(safe)).toEqual(['kb']);
  });

  it('is pure: returns a new object and never mutates the input', () => {
    const input = toolSet('ai-dev__task', 'ai-dev__kb');
    const before = Object.keys(input);
    const safe = designSafeTools(input);
    expect(safe).not.toBe(input);
    expect(Object.keys(input)).toEqual(before);
  });

  it('passes an empty set through', () => {
    expect(designSafeTools({})).toEqual({});
  });
});

describe('WRITE_TOOLS', () => {
  it('covers the Ship dispatch verb from one source of truth', () => {
    expect(WRITE_TOOLS.has(TASK_TOOL)).toBe(true);
  });
});
