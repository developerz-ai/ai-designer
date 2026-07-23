import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reduceChangeset,
  reduceTasks,
  saveMarkdown,
} from '@/entrypoints/sidepanel/stores/changeset';
import type { Changeset, Edit } from '@/shared/changeset';
import type { PanelToSw, SwToPanel } from '@/shared/messages';

// Pure folds: mirrors test/unit/mcp-panel-store.test.ts's reduceServers coverage — no chrome, no
// Solid mount required.

const changesetA: Changeset = {
  url: 'https://example.com/',
  createdAt: '2026-07-14T00:00:00.000Z',
  sessionId: '11111111-1111-4111-8111-111111111111',
  edits: [],
};

describe('reduceChangeset', () => {
  it('adopts the changeset carried on a `changeset` push', () => {
    expect(reduceChangeset(null, { type: 'changeset', changeset: changesetA })).toEqual(changesetA);
  });

  it('ignores unrelated messages', () => {
    const msg = { type: 'token', text: 'hi' } as SwToPanel;
    expect(reduceChangeset(changesetA, msg)).toBe(changesetA);
  });
});

const taskQueued: Extract<SwToPanel, { type: 'task-status' }> = {
  type: 'task-status',
  taskId: 't1',
  title: 'Fix contrast',
  index: 0,
  total: 2,
  status: 'queued',
};

describe('reduceTasks', () => {
  it('appends an unseen task', () => {
    expect(reduceTasks([], taskQueued)).toEqual([
      {
        taskId: 't1',
        title: 'Fix contrast',
        index: 0,
        total: 2,
        status: 'queued',
      },
    ]);
  });

  it('upserts by taskId, preserving position', () => {
    const working = { ...taskQueued, status: 'working' };
    const other = { ...taskQueued, taskId: 't2', index: 1 };
    const next = reduceTasks(reduceTasks(reduceTasks([], taskQueued), other), working);
    expect(next.map((t) => [t.taskId, t.status])).toEqual([
      ['t1', 'working'],
      ['t2', 'queued'],
    ]);
  });

  it('ignores unrelated messages', () => {
    const msg = { type: 'error', message: 'boom' } as SwToPanel;
    expect(reduceTasks([], msg)).toEqual([]);
  });
});

// RPC-level coverage: dispatch-only actions round-trip through chrome.runtime.sendMessage (fake, no
// real extension context), mirroring test/unit/mcp-panel-store.test.ts's pattern.
type SendMessage = (msg: PanelToSw) => unknown;

function installChromeFake(handle: SendMessage): { sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn(async (msg: unknown) => handle(msg as PanelToSw));
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
  return { sendMessage };
}

// jsdom doesn't implement URL.createObjectURL/revokeObjectURL — add them as plain static props
// (not vi.stubGlobal, which would replace the real URL constructor other code relies on).
function installUrlFake(): { createObjectURL: ReturnType<typeof vi.fn> } {
  const createObjectURL = vi.fn(() => 'blob:mock-url');
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = vi.fn();
  return { createObjectURL };
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('changeset store actions', () => {
  it('ship() dispatches `ship` with source defaulted to report', async () => {
    vi.resetModules();
    installUrlFake();
    const { sendMessage } = installChromeFake(() => ({ ok: true, routed: 'tasks', taskCount: 1 }));
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.ship();

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ship', source: 'report' }),
    );
    expect(store.shipping()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('ship() surfaces a failure without downloading anything', async () => {
    vi.resetModules();
    const { createObjectURL } = installUrlFake();
    installChromeFake(() => ({ ok: false, error: 'Nothing to ship yet — make some edits first.' }));
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.ship({ source: 'changeset' });

    expect(store.error()).toBe('Nothing to ship yet — make some edits first.');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('ship() falling back to a report downloads the brief and records the reason', async () => {
    vi.resetModules();
    const { createObjectURL } = installUrlFake();
    installChromeFake(() => ({
      ok: true,
      routed: 'report',
      markdown: '# Brief',
      filename: 'brief.md',
      reason: 'No backend connected.',
    }));
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.ship();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(store.fallbackReason()).toBe('No backend connected.');
  });

  it('downloadReport() never dispatches a ship, only saves the brief', async () => {
    vi.resetModules();
    const { createObjectURL } = installUrlFake();
    const { sendMessage } = installChromeFake(() => ({
      ok: true,
      routed: 'report',
      markdown: '# Brief',
      filename: 'brief.md',
    }));
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.downloadReport();

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'download-report' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('sendReport() dispatches `send-report` with the named target', async () => {
    vi.resetModules();
    installUrlFake();
    const { sendMessage } = installChromeFake(() => ({ ok: true, routed: 'tasks', taskCount: 1 }));
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.sendReport('ai-dev');

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send-report', target: 'ai-dev' }),
    );
  });

  it('a rejected RPC surfaces its message instead of throwing', async () => {
    vi.resetModules();
    installUrlFake();
    installChromeFake(() => {
      throw new Error('port closed');
    });
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.ship();

    expect(store.error()).toBe('port closed');
  });
});

describe('saveMarkdown', () => {
  it('creates and revokes a blob URL via an anchor click', () => {
    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const click = vi.fn();
    const original = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = original(tag);
      if (tag === 'a') el.click = click;
      return el;
    });

    saveMarkdown('# hi', 'report.md');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});

// --- slice-10 diff review: edit-recorded fold + curation RPCs -----------------------------------
// Same harness as 'changeset store actions' above (installChromeFake + resetModules + dynamic
// import per test) — the store's signals are module-level, so each RPC test re-imports fresh.

const editFixture = (intent: string): Edit => ({
  intent,
  selector: { value: `#${intent}`, strategy: 'id', fragile: false },
  changes: [{ prop: 'color', before: null, after: '#000' }],
  frameworkHints: [],
});

const changesetWith = (...intents: string[]): Changeset => ({
  ...changesetA,
  edits: intents.map(editFixture),
});

describe('reduceChangeset — edit-recorded', () => {
  it('appends the edit onto the running changeset without mutating it', () => {
    const base = changesetWith('a');
    const next = reduceChangeset(base, { type: 'edit-recorded', edit: editFixture('b') });

    expect(next).not.toBe(base);
    expect(next?.edits.map((e) => e.intent)).toEqual(['a', 'b']);
    expect(base.edits.map((e) => e.intent)).toEqual(['a']);
  });

  it('is a no-op on a null changeset — an edit alone cannot seed a session', () => {
    // edit-recorded carries only the Edit (no url/sessionId), so with no base changeset there is
    // nothing to extend; the Diff tab seeds via `changeset-get` instead (see the store's comment).
    expect(reduceChangeset(null, { type: 'edit-recorded', edit: editFixture('a') })).toBeNull();
  });

  it('a `changeset` push replaces the running changeset wholesale', () => {
    const replacement = changesetWith('x', 'y');
    expect(reduceChangeset(changesetWith('a'), { type: 'changeset', changeset: replacement })).toBe(
      replacement,
    );
  });
});

/** A `ChangesetResult` reply that satisfies the zod schema (all required fields present). */
const resultFixture = (over: Partial<Record<string, unknown>> = {}) => ({
  ok: true,
  changeset: changesetWith('a'),
  canUndo: true,
  canRedo: false,
  ...over,
});

describe('changeset curation RPCs', () => {
  it('undoEdit() dispatches `changeset-undo` and folds the reply into the signals', async () => {
    vi.resetModules();
    const reply = resultFixture({ changeset: changesetWith('a'), canUndo: true, canRedo: true });
    const { sendMessage } = installChromeFake(() => reply);
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.undoEdit();

    expect(sendMessage).toHaveBeenCalledWith({ type: 'changeset-undo' });
    expect(store.changeset()).toEqual(reply.changeset);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(true);
    expect(store.curating()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('redoEdit() dispatches `changeset-redo` and folds the reply', async () => {
    vi.resetModules();
    const reply = resultFixture({
      changeset: changesetWith('a', 'b'),
      canUndo: true,
      canRedo: false,
    });
    const { sendMessage } = installChromeFake(() => reply);
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.redoEdit();

    expect(sendMessage).toHaveBeenCalledWith({ type: 'changeset-redo' });
    expect(store.changeset()).toEqual(reply.changeset);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);
  });

  it('clearChangeset() dispatches `changeset-clear` and folds the emptied reply', async () => {
    vi.resetModules();
    const reply = resultFixture({ changeset: changesetWith(), canUndo: false, canRedo: false });
    const { sendMessage } = installChromeFake(() => reply);
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.clearChangeset();

    expect(sendMessage).toHaveBeenCalledWith({ type: 'changeset-clear' });
    expect(store.changeset()).toEqual(reply.changeset);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
  });

  it('removeEdit(2) dispatches `changeset-remove-edit` with the index and folds the reply', async () => {
    vi.resetModules();
    const reply = resultFixture({
      changeset: changesetWith('a', 'b'),
      canUndo: true,
      canRedo: false,
    });
    const { sendMessage } = installChromeFake(() => reply);
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.removeEdit(2);

    expect(sendMessage).toHaveBeenCalledWith({ type: 'changeset-remove-edit', index: 2 });
    expect(store.changeset()).toEqual(reply.changeset);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);
  });

  it('a busy reply surfaces the diff.busy hint but still applies the reported state', async () => {
    vi.resetModules();
    const reply = resultFixture({ busy: true, canUndo: false, canRedo: true });
    installChromeFake(() => reply);
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.undoEdit();

    expect(store.error()).toBe("Can't change the changeset while the agent is working.");
    expect(store.changeset()).toEqual(reply.changeset);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(true);
    expect(store.curating()).toBe(false);
  });

  it('curating() is true while the RPC is in flight and false after settle', async () => {
    vi.resetModules();
    let settle: (reply: unknown) => void = () => {};
    const inFlight = new Promise<unknown>((res) => {
      settle = res;
    });
    installChromeFake(() => inFlight);
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    const pending = store.undoEdit();
    expect(store.curating()).toBe(true);

    settle(resultFixture());
    await pending;
    expect(store.curating()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('a rejected curation RPC surfaces its message and still settles curating', async () => {
    vi.resetModules();
    installChromeFake(() => {
      throw new Error('port closed');
    });
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.clearChangeset();

    expect(store.error()).toBe('port closed');
    expect(store.curating()).toBe(false);
  });
});

describe('refreshChangeset', () => {
  it('dispatches `changeset-get` and folds the reply into the signals', async () => {
    vi.resetModules();
    const reply = resultFixture({
      changeset: changesetWith('a', 'b'),
      canUndo: true,
      canRedo: true,
    });
    const { sendMessage } = installChromeFake(() => reply);
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset();

    expect(sendMessage).toHaveBeenCalledWith({ type: 'changeset-get' });
    expect(store.changeset()).toEqual(reply.changeset);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(true);
    expect(store.error()).toBeNull();
  });

  it('folds a null changeset (tab with no session) over any prior state', async () => {
    vi.resetModules();
    installChromeFake(() => resultFixture({ changeset: null, canUndo: false, canRedo: false }));
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset();

    expect(store.changeset()).toBeNull();
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
  });

  it('a rejected request sets error() instead of throwing', async () => {
    vi.resetModules();
    installChromeFake(() => {
      throw new Error('SW gone');
    });
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset();

    expect(store.error()).toBe('SW gone');
    expect(store.changeset()).toBeNull();
  });
});
