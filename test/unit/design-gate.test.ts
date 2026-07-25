import { type ToolSet, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TASK_TOOL } from '@/mcp/backend';
import { designSafeTools, isWriteShaped, toolBaseName, WRITE_TOOLS } from '@/mcp/design-gate';

// design-gate unit (#117 + #120): the pure write-tool filter applied to the design-turn merge.
// The bypass being closed: a connected backend's raw `<id>__task` tool reaching the model,
// which would dispatch a task without the user-clicked Ship. #120 widens the gate to ANY
// write-SHAPED base name (deploy/create_pr/send_email/…), offered only when the user granted
// that base name (per-tool opt-in) — `task` itself can never be granted.

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

  it('case-folds: upper/mixed-case task variants cannot evade the deny-set', () => {
    const safe = designSafeTools(toolSet('ai-dev__TASK', 'ai-dev__Task', 'TASK', 'ai-dev__kb'));
    expect(Object.keys(safe)).toEqual(['ai-dev__kb']);
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

  it('every entry is lowercase — the invariant the case-folded compare depends on', () => {
    // isWriteTool folds the candidate name only; a mixed-case deny-set entry would
    // silently never match (fail-open for that verb).
    for (const entry of WRITE_TOOLS) {
      expect(entry).toBe(entry.toLowerCase());
    }
  });
});

describe('toolBaseName (#120)', () => {
  it('takes the trailing segment after the last namespace separator', () => {
    expect(toolBaseName('ai-dev__deploy')).toBe('deploy');
    expect(toolBaseName('id__my__task')).toBe('task'); // a sanitized id may itself contain __
    expect(toolBaseName('srv__create_pr')).toBe('create_pr');
  });

  it('returns an un-namespaced name as-is', () => {
    expect(toolBaseName('kb')).toBe('kb');
    expect(toolBaseName(TASK_TOOL)).toBe(TASK_TOOL);
  });
});

describe('isWriteShaped (#120 heuristic)', () => {
  it('matches side-effect verbs across `_`/`-`/camel word splits', () => {
    const writes = [
      'deploy',
      'create_pr',
      'createPr',
      'send_email',
      'send-email',
      'updateRecord',
      'delete',
      'publish',
      'merge',
      'execute',
      'submit',
    ];
    for (const name of writes) {
      expect(isWriteShaped(name), name).toBe(true);
    }
  });

  it('spares read-shaped names — the #21 zero-friction consult path', () => {
    const reads = [
      'kb',
      'search',
      'query',
      'get',
      'list',
      'read',
      'fetch',
      'find',
      'describe',
      'creator_stats', // `create` must match as a whole word, not a substring
      'run_query', // generic `run` deliberately spared — read tools flood with it
      'settings_list', // generic `set`/`list` spared
      'open_issues', // generic `open` spared
      'kb.search', // dotted names split into words too — neither is a verb
    ];
    for (const name of reads) {
      expect(isWriteShaped(name), name).toBe(false);
    }
  });
});

describe('designSafeTools per-tool grants (#120)', () => {
  it('with no grants, strips write-shaped tools but keeps reads', () => {
    const safe = designSafeTools(
      toolSet('ai-dev__deploy', 'ai-dev__create_pr', 'ai-dev__kb', 'ai-dev__creator_stats'),
    );
    expect(Object.keys(safe)).toEqual(['ai-dev__kb', 'ai-dev__creator_stats']);
  });

  it('a granted write-shaped tool survives the merge', () => {
    const safe = designSafeTools(
      toolSet('ai-dev__deploy', 'ai-dev__create_pr', 'ai-dev__kb'),
      new Set(['deploy']),
    );
    expect(Object.keys(safe)).toEqual(['ai-dev__deploy', 'ai-dev__kb']);
  });

  it('grants match on the BASE name regardless of the server namespace', () => {
    const safe = designSafeTools(
      toolSet('custom_1__deploy', 'github__deploy'),
      new Set(['deploy']),
    );
    expect(Object.keys(safe)).toEqual(['custom_1__deploy', 'github__deploy']);
  });

  it('a grant for one tool does not ungate a sibling write-shaped tool', () => {
    const safe = designSafeTools(
      toolSet('ai-dev__deploy', 'ai-dev__publish'),
      new Set(['publish']),
    );
    expect(Object.keys(safe)).toEqual(['ai-dev__publish']);
  });

  it('`task` is hard-stripped even when "granted" — the Ship verb can never ride a turn', () => {
    const safe = designSafeTools(toolSet('ai-dev__task', 'ai-dev__kb'), new Set(['task']));
    expect(Object.keys(safe)).toEqual(['ai-dev__kb']);
  });

  it('granting a read-shaped name is harmless — reads were never gated', () => {
    const safe = designSafeTools(toolSet('ai-dev__kb'), new Set(['kb', 'not-a-tool']));
    expect(Object.keys(safe)).toEqual(['ai-dev__kb']);
  });

  it('grants do not mutate the input set', () => {
    const input = toolSet('ai-dev__deploy', 'ai-dev__kb');
    const before = Object.keys(input);
    designSafeTools(input, new Set(['deploy']));
    expect(Object.keys(input)).toEqual(before);
  });
});
