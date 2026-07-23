import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { createSessionTools, type SessionToolDeps } from '@/agent/tools/session';
import { ChangesetStore } from '@/changeset/store';
import { type Changeset, type Edit, emptyChangeset } from '@/shared/changeset';
import type { SwToPanel, ToolResult } from '@/shared/messages';

// session.ts unit: the changeset-record tools bound to a ChangesetStore, with the persist hook and
// panel sink injected (no chrome.*). Asserts derivation (names/schemas), that each mutating tool
// updates the store + persists + streams, and that `handoff` only proposes — it never ships.

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

const seed = (): Changeset =>
  emptyChangeset('https://example.com/', '2026-07-13T00:00:00Z', SESSION_ID);

const anEdit = (intent: string): Edit => ({
  intent,
  selector: { value: '#cta', strategy: 'id', fragile: false },
  changes: [{ prop: 'color', before: '#000', after: '#fff' }],
  attrs: [],
  classes: [],
  frameworkHints: [],
});

function harness() {
  const store = new ChangesetStore(seed());
  const persisted: Changeset[] = [];
  const events: SwToPanel[] = [];
  const deps: SessionToolDeps = {
    store,
    persist: (cs) => {
      persisted.push(cs);
    },
    emit: (e) => {
      events.push(e);
    },
  };
  return { store, persisted, events, tools: createSessionTools(deps) };
}

// Session tools return a ToolResult; drive execute directly (no ToolExecutionOptions needed here).
type MinimalExecute = (input: unknown, opts: Record<string, unknown>) => Promise<ToolResult>;
function run(execute: unknown, input: unknown): Promise<ToolResult> {
  if (typeof execute !== 'function') throw new Error('tool is missing an execute function');
  return (execute as MinimalExecute)(input, {});
}

describe('createSessionTools: derivation', () => {
  it('exposes recordEdit / undo / redo / handoff', () => {
    expect(Object.keys(harness().tools).sort()).toEqual(['handoff', 'recordEdit', 'redo', 'undo']);
  });

  it('gives every tool a description and the ToolResult output schema', () => {
    for (const [name, t] of Object.entries(harness().tools)) {
      expect(t.description, name).toBeTruthy();
      const output = t.outputSchema as unknown as ZodType;
      expect(output.safeParse({ type: 'tool-result', ok: true }).success, name).toBe(true);
    }
  });

  it('derives recordEdit inputSchema from the Edit schema (intent required)', () => {
    const schema = harness().tools.recordEdit.inputSchema as unknown as ZodType;
    expect(schema.safeParse(anEdit('x')).success).toBe(true);
    // Missing intent (the user's "why") is rejected — it has no default.
    expect(schema.safeParse({ selector: { value: '#x', strategy: 'id' } }).success).toBe(false);
  });

  it('accepts an optional breakpoint (slice 16 — which viewport an edit targets)', () => {
    const schema = harness().tools.recordEdit.inputSchema as unknown as ZodType;
    expect(schema.safeParse(anEdit('x')).success).toBe(true); // still fine with no breakpoint
    expect(schema.safeParse({ ...anEdit('x'), breakpoint: 'iphone-se' }).success).toBe(true);
  });

  it('validates structured attr/class deltas (#139) and defaults them for legacy edits', () => {
    const schema = harness().tools.recordEdit.inputSchema as unknown as ZodType;
    const rich = schema.safeParse({
      ...anEdit('brand the CTA'),
      attrs: [
        { name: 'href', before: null, after: '/buy' },
        { name: 'title', before: 'Buy', after: null },
      ],
      classes: [
        { name: 'btn-primary', op: 'add' },
        { name: 'btn-ghost', op: 'remove' },
      ],
    });
    expect(rich.success).toBe(true);
    // A legacy edit (persisted before the fields existed — no attrs/classes keys at all) still
    // parses: both default to empty, the same forward-compat rule as ChangesetState.redoStack.
    const legacy = schema.safeParse(anEdit('x'));
    expect(legacy.success).toBe(true);
    if (legacy.success) {
      const data = legacy.data as Edit;
      expect(data.attrs).toEqual([]);
      expect(data.classes).toEqual([]);
    }
  });
});

describe('createSessionTools: changeset mutations persist + stream', () => {
  it('recordEdit appends to the changeset, persists, and streams edit-recorded', async () => {
    const { store, persisted, events, tools } = harness();
    const edit = anEdit('make the CTA pop');

    const res = await run(tools.recordEdit.execute, edit);

    expect(res).toMatchObject({ type: 'tool-result', ok: true, data: { edits: 1 } });
    expect(store.size).toBe(1);
    expect(persisted.at(-1)?.edits).toHaveLength(1);
    expect(events).toContainEqual({ type: 'edit-recorded', edit });
  });

  it('recordEdit persists the breakpoint an edit was made under emulation at', async () => {
    const { store, tools } = harness();
    const edit = { ...anEdit('shrink the nav'), breakpoint: 'iphone-se' };

    await run(tools.recordEdit.execute, edit);

    expect(store.current.edits.at(-1)?.breakpoint).toBe('iphone-se');
  });

  it('recordEdit persists and streams the structured attr/class delta (#139)', async () => {
    const { store, persisted, events, tools } = harness();
    const edit = {
      ...anEdit('add the brand class'),
      attrs: [{ name: 'data-variant', before: null, after: 'brand' }],
      classes: [{ name: 'btn-primary', op: 'add' as const }],
    };

    await run(tools.recordEdit.execute, edit);

    expect(store.current.edits.at(-1)?.attrs).toEqual(edit.attrs);
    expect(store.current.edits.at(-1)?.classes).toEqual(edit.classes);
    expect(persisted.at(-1)?.edits.at(-1)?.attrs).toEqual(edit.attrs);
    expect(events).toContainEqual({ type: 'edit-recorded', edit });
  });

  it('undo removes the last edit and streams the full changeset', async () => {
    const { store, persisted, events, tools } = harness();
    await run(tools.recordEdit.execute, anEdit('a'));
    await run(tools.recordEdit.execute, anEdit('b'));

    const res = await run(tools.undo.execute, {});

    expect(res).toMatchObject({ ok: true, data: { undone: true, edits: 1 } });
    expect(store.size).toBe(1);
    expect(persisted.at(-1)?.edits).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'changeset' });
  });

  it('redo re-applies the most recently undone edit', async () => {
    const { store, tools } = harness();
    await run(tools.recordEdit.execute, anEdit('a'));
    await run(tools.undo.execute, {});

    const res = await run(tools.redo.execute, {});

    expect(res).toMatchObject({ ok: true, data: { redone: true, edits: 1 } });
    expect(store.size).toBe(1);
  });

  it('undo on an empty changeset is a no-op that still reports ok', async () => {
    const { store, tools } = harness();
    const res = await run(tools.undo.execute, {});
    expect(res).toMatchObject({ ok: true, data: { undone: false, edits: 0 } });
    expect(store.size).toBe(0);
  });
});

describe('createSessionTools: handoff proposes but never ships', () => {
  it('returns the assembled changeset summary and emits no ship side effect', async () => {
    const { events, tools } = harness();
    await run(tools.recordEdit.execute, anEdit('a'));

    const res = await run(tools.handoff.execute, { summary: 'Recolor the CTA', backend: 'dev' });

    expect(res).toMatchObject({
      ok: true,
      data: { summary: 'Recolor the CTA', backend: 'dev', edits: 1, sessionId: SESSION_ID },
    });
    // Execute is reached only post-approval; it routes, it does not dispatch — no task-status.
    expect(events.some((e) => e.type === 'task-status')).toBe(false);
  });
});
