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
