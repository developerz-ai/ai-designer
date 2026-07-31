import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reduceChangeset,
  reduceTasks,
  saveMarkdown,
  type TaskStatus,
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
        key: 't1',
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

  it('keeps one row per failed create, which never got a taskId', () => {
    // src/mcp/handoff.ts `dispatchTask` emits its catch with `taskId: ''` (the create threw before
    // an id existed). Keyed on taskId alone, three failures collapsed onto one row reading
    // "task 3/3" — so the user saw one error and believed two tasks had been created.
    const failed = (index: number) => ({
      ...taskQueued,
      taskId: '',
      title: `Problem ${index + 1}`,
      index,
      total: 3,
      status: 'error',
      error: 'backend unreachable',
    });
    const next = [0, 1, 2].reduce((acc, i) => reduceTasks(acc, failed(i)), [] as TaskStatus[]);

    expect(next).toHaveLength(3);
    expect(next.map((t) => t.key)).toEqual(['idx:0', 'idx:1', 'idx:2']);
    expect(next.map((t) => t.title)).toEqual(['Problem 1', 'Problem 2', 'Problem 3']);
  });

  it('still upserts a failed task by index when its status pushes twice', () => {
    const first = { ...taskQueued, taskId: '', index: 1, status: 'queued' };
    const then = { ...first, status: 'error' };
    const next = reduceTasks(reduceTasks([], first), then);
    expect(next.map((t) => [t.key, t.status])).toEqual([['idx:1', 'error']]);
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

// Port fake for the push stream `initChangesetStore` folds (mirrors chat-panel-store.test.ts's).
function installPortFake(): { emit: (msg: SwToPanel) => void } {
  const listeners: Array<(msg: unknown) => void> = [];
  const port = {
    onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.push(fn) },
    onDisconnect: { addListener: (_fn: () => void) => {} },
    postMessage: () => {},
  };
  const chromeFake = (globalThis as { chrome?: { runtime?: Record<string, unknown> } }).chrome;
  if (chromeFake?.runtime) chromeFake.runtime.connect = () => port;
  return {
    emit: (msg) => {
      for (const fn of listeners) fn(msg);
    },
  };
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

  it('a second ship starts a fresh timeline instead of appending to the first', async () => {
    // Two fan-outs stacked in one list read as a single six-task dispatch — each ship's rows carry
    // their own "task 1/2" counters.
    vi.resetModules();
    installUrlFake();
    installChromeFake(() => ({ ok: true, routed: 'tasks', taskCount: 1 }));
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    const port = installPortFake();

    store.initChangesetStore();
    await store.ship();
    port.emit({ ...taskQueued, taskId: 'first-ship' });
    expect(store.tasks).toHaveLength(1);

    await store.ship();
    expect(store.tasks).toHaveLength(0);
    port.emit({ ...taskQueued, taskId: 'second-ship' });
    expect(store.tasks.map((t) => t.taskId)).toEqual(['second-ship']);
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
  // This used to assert a SYNCHRONOUS revoke, which is what made the download silently fail:
  // `a.click()` only schedules the download, so releasing the blob URL in the same tick pulls it
  // out from under the browser before it reads it. The test encoded the bug, so it kept passing.
  // The ordering contract now lives in test/unit/save-markdown.test.ts; this keeps the store-level
  // check that the click happens at all.
  it('creates a blob URL and clicks an anchor, WITHOUT revoking it in the same tick', () => {
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
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});

// --- slice-10 diff review: edit-recorded fold + curation RPCs -----------------------------------
// Same harness as 'changeset store actions' above (installChromeFake + resetModules + dynamic
// import per test) — the store's signals are module-level, so each RPC test re-imports fresh.

const editFixture = (intent: string): Edit => ({
  intent,
  selector: { value: `#${intent}`, strategy: 'id', fragile: false },
  changes: [{ prop: 'color', before: null, after: '#000' }],
  attrs: [],
  classes: [],
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
  tabId: 1 as number | null,
  changeset: changesetWith('a'),
  canUndo: true,
  canRedo: false,
  ...over,
});

describe('changeset curation RPCs', () => {
  // Every curation test keys the view first (a refresh reply), exactly like the UI: the Diff tab
  // mounts -> refreshChangeset -> viewTabId set — and the store REFUSES to curate an unkeyed view.
  it('undoEdit() dispatches `changeset-undo` and folds the reply into the signals', async () => {
    vi.resetModules();
    const reply = resultFixture({ changeset: changesetWith('a'), canUndo: true, canRedo: true });
    const { sendMessage } = installChromeFake(() => reply);
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset();
    await store.undoEdit();

    expect(sendMessage).toHaveBeenCalledWith({ type: 'changeset-undo', forTabId: 1 });
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

    await store.refreshChangeset();
    await store.redoEdit();

    expect(sendMessage).toHaveBeenCalledWith({ type: 'changeset-redo', forTabId: 1 });
    expect(store.changeset()).toEqual(reply.changeset);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);
  });

  it('clearChangeset() dispatches `changeset-clear` and folds the emptied reply', async () => {
    vi.resetModules();
    const reply = resultFixture({ changeset: changesetWith(), canUndo: false, canRedo: false });
    const { sendMessage } = installChromeFake(() => reply);
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset();
    await store.clearChangeset();

    expect(sendMessage).toHaveBeenCalledWith({ type: 'changeset-clear', forTabId: 1 });
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

    await store.refreshChangeset();
    await store.removeEdit(2);

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'changeset-remove-edit',
      index: 2,
      forTabId: 1,
    });
    expect(store.changeset()).toEqual(reply.changeset);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);
  });

  it('a busy reply surfaces the diff.busy hint on the Diff-local error, not the shared one', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake((msg) =>
      msg.type === 'changeset-get'
        ? resultFixture()
        : resultFixture({ busy: true, canUndo: false, canRedo: true }),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset();
    await store.undoEdit();

    expect(store.diffError()).toBe("Can't change the changeset while the agent is working.");
    expect(store.error()).toBeNull(); // the Ship surface's error is untouched
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['a']); // busy echo applied
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(true);
    expect(store.curating()).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'changeset-undo', forTabId: 1 });
  });

  it('curating() is true while the RPC is in flight and false after settle', async () => {
    vi.resetModules();
    let settle: (reply: unknown) => void = () => {};
    const inFlight = new Promise<unknown>((res) => {
      settle = res;
    });
    installChromeFake((msg) => (msg.type === 'changeset-get' ? resultFixture() : inFlight));
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset();
    const pending = store.undoEdit();
    expect(store.curating()).toBe(true);

    settle(resultFixture());
    await pending;
    expect(store.curating()).toBe(false);
    expect(store.diffError()).toBeNull();
    expect(store.error()).toBeNull();
  });

  it('a rejected curation RPC surfaces its message on diffError and still settles curating', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'changeset-get') return resultFixture();
      throw new Error('port closed');
    });
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset();
    await store.clearChangeset();

    expect(store.diffError()).toBe('port closed');
    expect(store.error()).toBeNull();
    expect(store.curating()).toBe(false);
  });

  it('refuses to curate an unkeyed view — re-keys instead of gambling on the active tab', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(() => resultFixture());
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.undoEdit(); // no refresh ever landed: viewTabId is null

    expect(sentTypes(sendMessage)).toEqual(['changeset-get']); // the re-key, never the mutator
    await vi.waitFor(() => expect(store.viewTabId()).toBe(1)); // the re-key lands
    expect(store.diffError()).toBeNull(); // ...and its clean reply clears the refusal hint
  });

  it('a hard-failure reply keeps the current view (the durable record is intact)', async () => {
    vi.resetModules();
    installChromeFake((msg) =>
      msg.type === 'changeset-get'
        ? resultFixture({ changeset: changesetWith('a', 'b') })
        : {
            ok: false,
            tabId: 1,
            changeset: null,
            canUndo: false,
            canRedo: false,
            error: 'quota exceeded',
          },
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset();
    await store.undoEdit();

    expect(store.diffError()).toBe('quota exceeded');
    // The view was NOT blanked by the failure's null-view reply.
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['a', 'b']);
    expect(store.canUndo()).toBe(true);
  });

  it('a clean refresh clears a stale Diff hint (no sticky banners)', async () => {
    vi.resetModules();
    let busyOnce = true;
    installChromeFake((msg) => {
      if (msg.type === 'changeset-get') return resultFixture();
      if (busyOnce) {
        busyOnce = false;
        return resultFixture({ busy: true });
      }
      return resultFixture();
    });
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset();
    await store.undoEdit(); // busy -> hint
    expect(store.diffError()).toBe("Can't change the changeset while the agent is working.");

    await store.refreshChangeset(); // a settle/retarget refresh lands clean -> hint cleared
    expect(store.diffError()).toBeNull();
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

  it('a rejected request sets diffError() instead of throwing', async () => {
    vi.resetModules();
    installChromeFake(() => {
      throw new Error('SW gone');
    });
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset();

    expect(store.diffError()).toBe('SW gone');
    expect(store.error()).toBeNull();
    expect(store.changeset()).toBeNull();
  });
});

// --- slice-10 review fix-forward (#141): tab keying, drift, dedupe, settle signals --------------

/** installChromeFake + a long-lived Port double, for the subscribe-side (initChangesetStore) tests.
 *  `push` feeds one SW->panel message through the captured onMessage listener. */
function installChromeFakeWithPort(handle: SendMessage): {
  sendMessage: ReturnType<typeof vi.fn>;
  push: (msg: unknown) => void;
} {
  const sendMessage = vi.fn(async (msg: unknown) => handle(msg as PanelToSw));
  let portListener: ((msg: unknown) => void) | null = null;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage,
      connect: () => ({
        onMessage: {
          addListener: (fn: (msg: unknown) => void) => {
            portListener = fn;
          },
        },
        onDisconnect: { addListener: () => {} },
      }),
    },
  };
  return { sendMessage, push: (msg) => portListener?.(msg) };
}

const sentTypes = (sendMessage: ReturnType<typeof vi.fn>): string[] =>
  sendMessage.mock.calls.map(([m]) => (m as { type: string }).type);

describe('reduceChangeset — edit-recorded duplicate guard', () => {
  it('drops an immediate duplicate append (get reply beat the push to the panel)', () => {
    const base = changesetWith('a');
    // The same edit arriving via the push that the get reply already carried: fold is identity.
    expect(reduceChangeset(base, { type: 'edit-recorded', edit: editFixture('a') })).toBe(base);
  });

  it('still appends a genuinely different repeat (not a duplicate)', () => {
    const base = changesetWith('a');
    const next = reduceChangeset(base, { type: 'edit-recorded', edit: editFixture('b') });
    expect(next?.edits.map((e) => e.intent)).toEqual(['a', 'b']);
  });
});

describe('changeset store — tab keying + settle signals (push side)', () => {
  it('an edit-recorded push clears canRedo (a record mid-turn forks history)', async () => {
    vi.resetModules();
    const { push } = installChromeFakeWithPort(() =>
      resultFixture({ changeset: changesetWith('a'), canRedo: true }),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();
    await store.refreshChangeset(); // seeds changeset + canRedo:true + viewTabId
    expect(store.canRedo()).toBe(true);

    push({ type: 'edit-recorded', edit: editFixture('b') });

    expect(store.canRedo()).toBe(false);
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['a', 'b']);
  });

  it('a changeset push stamped for another tab is dropped; one for the view tab folds', async () => {
    vi.resetModules();
    const { push } = installChromeFakeWithPort(() =>
      resultFixture({ tabId: 1, changeset: changesetWith('a') }),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();
    await store.refreshChangeset(); // keys the view to tab 1

    push({ type: 'changeset', changeset: changesetWith('x', 'y'), tabId: 5 });
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['a']);

    push({ type: 'changeset', changeset: changesetWith('x', 'y'), tabId: 1 });
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['x', 'y']);
  });

  it('session-state non-running refreshes (covers the Stop path); running does not', async () => {
    vi.resetModules();
    const { sendMessage, push } = installChromeFakeWithPort(() => resultFixture());
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();

    push({ type: 'session-state', state: 'stopped' });
    await vi.waitFor(() => expect(sentTypes(sendMessage)).toContain('changeset-get'));

    sendMessage.mockClear();
    push({ type: 'session-state', state: 'running' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sentTypes(sendMessage)).not.toContain('changeset-get');
  });

  it('turn-done is skipped while a curation RPC is in flight (its reply is newer)', async () => {
    vi.resetModules();
    let settle: (reply: unknown) => void = () => {};
    const inFlight = new Promise<unknown>((res) => {
      settle = res;
    });
    const { sendMessage, push } = installChromeFakeWithPort((msg) =>
      msg.type === 'changeset-undo' ? inFlight : resultFixture(),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();

    await store.refreshChangeset(); // keys the view (mutators refuse an unkeyed view)
    sendMessage.mockClear();
    const pending = store.undoEdit();
    expect(store.curating()).toBe(true);

    push({ type: 'turn-done', usage: { steps: 1, tokens: 1 } });
    await Promise.resolve();
    await Promise.resolve();
    expect(sentTypes(sendMessage)).not.toContain('changeset-get');

    settle(resultFixture());
    await pending;
  });

  it('an edit-recorded push stamped for another tab is dropped; one for the view tab folds', async () => {
    vi.resetModules();
    const { push } = installChromeFakeWithPort(() =>
      resultFixture({ tabId: 1, changeset: changesetWith('a') }),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();
    await store.refreshChangeset(); // keys the view to tab 1

    // A turn running on tab 5 keeps emitting while the user looks at tab 1: no phantom rows.
    push({ type: 'edit-recorded', edit: editFixture('phantom'), tabId: 5 });
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['a']);

    push({ type: 'edit-recorded', edit: editFixture('b'), tabId: 1 });
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['a', 'b']);
  });
});

describe('changeset store — curation fix-forward (reply side)', () => {
  it('a changeset-get reply that lands after a curation started is dropped as stale', async () => {
    vi.resetModules();
    let gets = 0;
    let settleGet: (reply: unknown) => void = () => {};
    const getReply = new Promise<unknown>((res) => {
      settleGet = res;
    });
    installChromeFake((msg) => {
      if (msg.type === 'changeset-get') {
        gets++;
        return gets === 1 ? resultFixture({ changeset: changesetWith('a') }) : getReply;
      }
      return resultFixture({ changeset: changesetWith('b'), canUndo: true });
    });
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset(); // keys the view (settled, 'a')
    const refresh = store.refreshChangeset(); // second get: in flight, pre-op view
    await store.undoEdit(); // newer truth: applies 'b'
    settleGet(resultFixture({ changeset: changesetWith('a') })); // stale get reply lands late
    await refresh;

    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['b']);
  });

  it('back-to-back refreshes apply only the newest reply (last-call-wins)', async () => {
    vi.resetModules();
    const replies: Array<(reply: unknown) => void> = [];
    installChromeFake((msg) =>
      msg.type === 'changeset-get'
        ? new Promise((res) => {
            replies.push(res);
          })
        : resultFixture(),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    const r1 = store.refreshChangeset(); // rapid tab switches: two overlapping refreshes
    const r2 = store.refreshChangeset();
    replies[1]?.(resultFixture({ changeset: changesetWith('b') })); // newer call replies first
    await r2;
    replies[0]?.(resultFixture({ changeset: changesetWith('a') })); // older call replies late — stale
    await r1;

    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['b']);
  });

  it('a not-ok changeset-get reply surfaces its error and keeps the current view', async () => {
    vi.resetModules();
    let gets = 0;
    installChromeFake((msg) => {
      if (msg.type === 'changeset-get') {
        gets++;
        return gets === 1
          ? resultFixture({ changeset: changesetWith('a') })
          : {
              ok: false,
              tabId: null,
              changeset: null,
              canUndo: false,
              canRedo: false,
              error: 'read failed',
            };
      }
      return resultFixture();
    });
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset(); // keys the view with 'a'
    await store.refreshChangeset(); // SW-side read failure

    expect(store.diffError()).toBe('read failed');
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['a']); // not blanked
  });

  it('a tab-drift reply hints + auto-refreshes to the newly active tab', async () => {
    vi.resetModules();
    let gets = 0;
    let settleSecondGet: (reply: unknown) => void = () => {};
    const secondGet = new Promise<unknown>((res) => {
      settleSecondGet = res;
    });
    const { sendMessage } = installChromeFake((msg) => {
      if (msg.type === 'changeset-get') {
        gets++;
        return gets === 1 ? resultFixture({ tabId: 42, changeset: changesetWith('a') }) : secondGet;
      }
      return {
        ok: false,
        tabId: 9,
        changeset: null,
        canUndo: false,
        canRedo: false,
        error: 'tab-drift',
      };
    });
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset(); // keys the view to tab 42
    await store.undoEdit(); // forTabId 42 drift-rejected; SW now resolves tab 9

    // Deterministic: the auto-refresh's reply is still parked, so the hint is observable.
    expect(store.diffError()).toBe("Tab changed — showing the record of the tab you're on now.");
    expect(store.error()).toBeNull();
    expect(sentTypes(sendMessage)).toEqual(['changeset-get', 'changeset-undo', 'changeset-get']);

    settleSecondGet(resultFixture({ tabId: 9, changeset: null, canUndo: false, canRedo: false }));
    await vi.waitFor(() => expect(store.viewTabId()).toBe(9));
    expect(store.diffError()).toBeNull(); // the clean re-key clears the drift banner
  });

  it('mutators send the displayed tab as forTabId once the view is keyed', async () => {
    vi.resetModules();
    // Every reply keys (or re-keys) the view — get AND mutator replies carry tabId 42 here, so the
    // forTabId the mutators send must stay 42.
    const { sendMessage } = installChromeFake(() => resultFixture({ tabId: 42 }));
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    await store.refreshChangeset();
    expect(store.viewTabId()).toBe(42);

    await store.undoEdit();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'changeset-undo', forTabId: 42 });

    await store.removeEdit(0);
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'changeset-remove-edit',
      index: 0,
      forTabId: 42,
    });
  });
});

// --- #142 sweep: unkeyed re-key (item 6), undo-shape canRedo (item 15), stale-refresh failure
// guard (item 8), pending retarget (item 3) + skipped turn-refresh re-fire (item 4) -------------

describe('changeset store — unkeyed first-turn re-key (#142 item 6)', () => {
  it('a stamped push on a never-keyed view fires the re-key refresh instead of dropping', async () => {
    vi.resetModules();
    const { sendMessage, push } = installChromeFakeWithPort(() =>
      resultFixture({ tabId: 7, changeset: changesetWith('a'), canUndo: true }),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore(); // no refreshChangeset: the view was never keyed
    expect(store.viewTabId()).toBeNull();

    // The first turn's record pushes arrive tab-stamped before any get reply could key the view.
    push({ type: 'edit-recorded', edit: editFixture('b'), tabId: 7 });

    await vi.waitFor(() => expect(sentTypes(sendMessage)).toContain('changeset-get'));
    await vi.waitFor(() => expect(store.viewTabId()).toBe(7));
    // The push itself was dropped, but the re-key's reply carries the persisted record.
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['a']);
  });

  it('a stamped push for ANOTHER tab on a keyed view still drops without a re-key', async () => {
    vi.resetModules();
    const { sendMessage, push } = installChromeFakeWithPort(() =>
      resultFixture({ tabId: 1, changeset: changesetWith('a') }),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();
    await store.refreshChangeset(); // keys the view to tab 1
    sendMessage.mockClear();

    push({ type: 'edit-recorded', edit: editFixture('phantom'), tabId: 5 });

    await Promise.resolve();
    await Promise.resolve();
    expect(sentTypes(sendMessage)).not.toContain('changeset-get'); // no re-key — keyed deliberately
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['a']);
  });
});

describe('changeset store — undo-shape canRedo rule (#142 item 15)', () => {
  it('an undo-shaped changeset push asserts canRedo true (an agent undo GROWS the redo tail)', async () => {
    vi.resetModules();
    const { push } = installChromeFakeWithPort(() =>
      resultFixture({ tabId: 1, changeset: changesetWith('a', 'b'), canRedo: false }),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();
    await store.refreshChangeset(); // keyed to 1, view [a, b], canRedo false
    expect(store.canRedo()).toBe(false);

    // The agent's session-undo push mid-turn: same session, one edit shorter, strict prefix.
    push({ type: 'changeset', changeset: changesetWith('a'), tabId: 1 });

    expect(store.canRedo()).toBe(true); // the undone 'b' is redoable — no more stale-false
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['a']);
  });

  it('a non-undo-shaped changeset push still forces canRedo false (fork / nav-clear residual)', async () => {
    vi.resetModules();
    const { push } = installChromeFakeWithPort(() =>
      resultFixture({ tabId: 1, changeset: changesetWith('a', 'b'), canRedo: true }),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();
    await store.refreshChangeset(); // keyed to 1, canRedo true
    expect(store.canRedo()).toBe(true);

    // Append shape (a redo-origin push — the tail may stay >0, but the panel can't tell: the
    // conservative force-false stays; the settle refresh heals it).
    push({ type: 'changeset', changeset: changesetWith('a', 'b', 'c'), tabId: 1 });
    expect(store.canRedo()).toBe(false);

    // Re-arm via an undo-shaped push, then a nav-clear wipe (fresh sessionId) must force false.
    push({ type: 'changeset', changeset: changesetWith('a', 'b'), tabId: 1 });
    expect(store.canRedo()).toBe(true);
    push({
      type: 'changeset',
      changeset: { ...changesetWith(), sessionId: '22222222-2222-4222-8222-222222222222' },
      tabId: 1,
    });
    expect(store.canRedo()).toBe(false);
  });

  it('the own-RPC echo stays exempt while curating (the reply re-asserts canRedo)', async () => {
    vi.resetModules();
    let settle: (reply: unknown) => void = () => {};
    const inFlight = new Promise<unknown>((res) => {
      settle = res;
    });
    const { push } = installChromeFakeWithPort((msg) =>
      msg.type === 'changeset-undo'
        ? inFlight
        : resultFixture({ tabId: 1, changeset: changesetWith('a'), canRedo: true }),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();
    await store.refreshChangeset(); // keyed to 1, canRedo true

    const pending = store.undoEdit();
    expect(store.curating()).toBe(true);

    // A non-undo-shaped push (a clear) landing mid-curate must NOT touch canRedo.
    push({ type: 'changeset', changeset: changesetWith(), tabId: 1 });
    expect(store.canRedo()).toBe(true);

    settle(resultFixture({ tabId: 1, changeset: changesetWith(), canRedo: false }));
    await pending;
    expect(store.canRedo()).toBe(false); // the authoritative reply re-asserted
  });
});

describe('changeset store — stale refresh failure guard (#142 item 8)', () => {
  it("a superseded refresh's rejection does not post the banner over the newer clean view", async () => {
    vi.resetModules();
    const replies: Array<{ res: (r: unknown) => void; rej: (e: unknown) => void }> = [];
    installChromeFake((msg) =>
      msg.type === 'changeset-get'
        ? new Promise((res, rej) => {
            replies.push({ res, rej });
          })
        : resultFixture(),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');

    const r1 = store.refreshChangeset(); // older call — will reject late
    const r2 = store.refreshChangeset(); // newer call — wins the seq race
    replies[1]?.res(resultFixture({ changeset: changesetWith('b') }));
    await r2;
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['b']);

    replies[0]?.rej(new Error('SW gone')); // the stale call's failure lands AFTER the clean view
    await r1;

    expect(store.diffError()).toBeNull(); // no banner over the newer successful view
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['b']);
  });
});

/** installChromeFakeWithPort + a captured `chrome.tabs.onActivated` listener, for the retarget
 *  (item 3) tests: `fireRetarget` plays a tab switch. */
function installChromeFakeWithRetarget(handle: SendMessage): {
  sendMessage: ReturnType<typeof vi.fn>;
  push: (msg: unknown) => void;
  fireRetarget: () => void;
} {
  const sendMessage = vi.fn(async (msg: unknown) => handle(msg as PanelToSw));
  let portListener: ((msg: unknown) => void) | null = null;
  let retargetListener: (() => void) | null = null;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage,
      connect: () => ({
        onMessage: {
          addListener: (fn: (msg: unknown) => void) => {
            portListener = fn;
          },
        },
        onDisconnect: { addListener: () => {} },
      }),
    },
    tabs: {
      onActivated: {
        addListener: (fn: () => void) => {
          retargetListener = fn;
        },
      },
    },
  };
  return {
    sendMessage,
    push: (msg) => portListener?.(msg),
    fireRetarget: () => retargetListener?.(),
  };
}

describe('changeset store — pending retarget + skipped settle refresh (#142 items 3+4)', () => {
  it('a tab switch swallowed mid-curate re-fires when the curate settles', async () => {
    vi.resetModules();
    let settle: (reply: unknown) => void = () => {};
    const inFlight = new Promise<unknown>((res) => {
      settle = res;
    });
    const { sendMessage, fireRetarget } = installChromeFakeWithRetarget((msg) =>
      msg.type === 'changeset-undo' ? inFlight : resultFixture({ tabId: 1 }),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();
    await store.refreshChangeset(); // keys the view
    sendMessage.mockClear();

    const pending = store.undoEdit();
    expect(store.curating()).toBe(true);

    fireRetarget(); // a tab switch landing between SW tab-resolution and the reply
    await Promise.resolve();
    await Promise.resolve();
    expect(sentTypes(sendMessage)).not.toContain('changeset-get'); // swallowed while curating

    settle(resultFixture({ tabId: 1 }));
    await pending;
    await vi.waitFor(() => expect(sentTypes(sendMessage)).toContain('changeset-get')); // re-fired
  });

  it('a tab switch while NOT curating refreshes immediately (no pending carry-over)', async () => {
    vi.resetModules();
    const { sendMessage, fireRetarget } = installChromeFakeWithRetarget(() => resultFixture());
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();
    await store.refreshChangeset();
    sendMessage.mockClear();

    fireRetarget();

    await vi.waitFor(() => expect(sentTypes(sendMessage)).toEqual(['changeset-get']));
  });

  it('a turn-done skipped during a FAILING curate re-fires on settle (transport throw)', async () => {
    vi.resetModules();
    let fail: (e: unknown) => void = () => {};
    const inFlight = new Promise<unknown>((_res, rej) => {
      fail = rej;
    });
    const { sendMessage, push } = installChromeFakeWithPort((msg) =>
      msg.type === 'changeset-undo' ? inFlight : resultFixture({ tabId: 1 }),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();
    await store.refreshChangeset(); // keys the view
    sendMessage.mockClear();

    const pending = store.undoEdit();
    push({ type: 'turn-done', usage: { steps: 1, tokens: 1 } }); // skipped: the curate is newer
    await Promise.resolve();
    await Promise.resolve();
    expect(sentTypes(sendMessage)).not.toContain('changeset-get');

    fail(new Error('port closed')); // the curate dies without refreshing — the skip must retry
    await pending;
    await vi.waitFor(() => expect(sentTypes(sendMessage)).toContain('changeset-get'));
    await vi.waitFor(() => expect(store.diffError()).toBeNull()); // the landing refresh heals it
  });

  it('a turn-done skipped during a SUCCESSFUL curate does not re-fire (the reply covered it)', async () => {
    vi.resetModules();
    let settle: (reply: unknown) => void = () => {};
    const inFlight = new Promise<unknown>((res) => {
      settle = res;
    });
    const { sendMessage, push } = installChromeFakeWithPort((msg) =>
      msg.type === 'changeset-undo' ? inFlight : resultFixture({ tabId: 1 }),
    );
    const store = await import('@/entrypoints/sidepanel/stores/changeset');
    store.initChangesetStore();
    await store.refreshChangeset(); // keys the view
    sendMessage.mockClear();

    const pending = store.undoEdit();
    push({ type: 'turn-done', usage: { steps: 1, tokens: 1 } }); // skipped: the curate is newer

    settle(resultFixture({ tabId: 1, changeset: changesetWith('b') }));
    await pending; // the applied reply IS the authoritative post-turn view — no re-fire
    await Promise.resolve();
    await Promise.resolve();
    expect(sentTypes(sendMessage)).not.toContain('changeset-get');
    expect(store.changeset()?.edits.map((e) => e.intent)).toEqual(['b']);
  });
});
