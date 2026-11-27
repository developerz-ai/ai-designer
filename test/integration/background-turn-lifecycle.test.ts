import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunTurnArgs, TurnOutcome } from '@/agent/loop';
import type { Edit } from '@/shared/changeset';
import type { ToolResult } from '@/shared/messages';

// The REAL background.ts (stubbed `chrome`, as background.test.ts boots it), with `runTurn`
// replaced by a controllable fake that hands the test the turn's real dispatches + session tools.
// Pins the running-turn lifecycle against the outside world:
//   • an agent click that commits a new document REBASES the turn (no abort), and an edit
//     recorded after it persists against the new document (it was silently dropped before);
//   • the page navigating on its own still aborts the turn;
//   • closing the turn's tab aborts the turn, and a later recordEdit cannot resurrect
//     `changeset:<tabId>`;
//   • a Stop / newer Send during turn SETUP is honoured, and an older turn's setup can never
//     abort the newer turn that superseded it.

vi.mock('#imports', () => ({ defineBackground: (callback: () => void) => callback }));
vi.mock('@/agent/config-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agent/config-store')>()),
  getProviderConfig: async () => ({ baseURL: 'http://localhost:1234/v1', model: 'test' }),
  migrateLegacyProvider: async () => {},
}));
vi.mock('@/agent/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agent/provider')>()),
  createProvider: () => ({}),
  keyMissing: () => false,
}));
const mocks = vi.hoisted(() => ({ runTurn: vi.fn() }));
vi.mock('@/agent/loop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agent/loop')>()),
  runTurn: mocks.runTurn,
}));
vi.mock('@/mcp/manager', () => ({
  McpManager: class {
    async hydrate() {}
    async list() {
      return [];
    }
    async toolsFor() {
      return {};
    }
  },
}));

const OLD = 'https://shop.example/';
const NEW = 'https://shop.example/checkout';

const OUTCOME: TurnOutcome = {
  text: '',
  responseMessages: [],
  usage: { steps: 0, tokens: 0, visionCalls: 0, waitCalls: 0, navCalls: 0 },
  stop: 'done',
  budgetReason: null,
};

const anEdit: Edit = {
  intent: 'make the CTA pop',
  selector: { value: '#cta', strategy: 'id', fragile: false },
  changes: [{ prop: 'color', before: '#000', after: '#fff' }],
  attrs: [],
  classes: [],
  frameworkHints: [],
};

type Listener = (raw: unknown, sender: object, reply: (value: unknown) => void) => unknown;
type Commit = {
  frameId: number;
  tabId: number;
  url: string;
  transitionType: string;
};

function boot(opts: { query?: () => Promise<unknown[]> } = {}) {
  const session: Record<string, unknown> = { 'committedUrl:7': OLD };
  const area = (data: Record<string, unknown>) => ({
    get: async (key: string | string[] | null) => {
      if (key === null) return { ...data };
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    },
    remove: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) delete data[k];
    },
  });
  const listeners: Listener[] = [];
  const commits: Array<(details: Commit) => void> = [];
  const removed: Array<(id: number) => void> = [];
  const event = { addListener: () => {} };
  vi.stubGlobal('chrome', {
    storage: { session: area(session), local: area({}) },
    runtime: {
      onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
      onConnect: event,
      onInstalled: event,
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getManifest: () => ({ version: '0.0.0' }),
    },
    tabs: {
      query: opts.query ?? (async () => [{ id: 7, url: OLD }]),
      get: async () => ({ id: 7, url: OLD, active: true }),
      sendMessage: async () => ({ type: 'tool-result', ok: true }),
      onRemoved: { addListener: (listener: (id: number) => void) => removed.push(listener) },
    },
    webNavigation: {
      onCommitted: { addListener: (listener: (d: Commit) => void) => commits.push(listener) },
    },
    sidePanel: {
      setPanelBehavior: async () => {},
      setOptions: async () => {},
      open: async () => {},
    },
    action: { onClicked: event },
  });
  const rpc = (message: object) =>
    new Promise<Record<string, unknown>>((resolve) => {
      for (const listener of listeners)
        listener(message, {}, (value) => resolve(value as Record<string, unknown>));
    });
  const commit = (url: string) => {
    for (const listener of commits) listener({ frameId: 0, tabId: 7, url, transitionType: 'link' });
  };
  const closeTab = () => {
    for (const listener of removed) listener(7);
  };
  // A content-script push from tab 7's top frame.
  const push = (message: object) => {
    for (const listener of listeners) listener(message, { tab: { id: 7 }, frameId: 0 }, () => {});
  };
  return { session, rpc, commit, closeTab, push };
}

async function start(): Promise<void> {
  const { default: main } = await import('@/entrypoints/background');
  (main as unknown as () => void)();
}

type MinimalExecute = (input: unknown, opts: Record<string, unknown>) => Promise<ToolResult>;
function recordEdit(args: RunTurnArgs): Promise<ToolResult> {
  const execute = args.tools?.recordEdit?.execute;
  if (typeof execute !== 'function') throw new Error('recordEdit missing');
  return (execute as unknown as MinimalExecute)(anEdit, {});
}

let turns: RunTurnArgs[];
let finish: Array<(outcome: TurnOutcome) => void>;

beforeEach(() => {
  turns = [];
  finish = [];
  mocks.runTurn.mockImplementation(
    (args: RunTurnArgs) =>
      new Promise<TurnOutcome>((resolve) => {
        turns.push(args);
        finish.push(resolve);
      }),
  );
});

afterEach(async () => {
  for (const done of finish) done(OUTCOME);
  // Let the released turns finalize against the stub before it is removed.
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('agent navigation mid-turn', () => {
  it('an agent click that commits a new document rebases the turn; later edits persist', async () => {
    const env = boot();
    await start();
    expect((await env.rpc({ type: 'user-message', text: 'go to checkout' })).ok).toBe(true);
    const turn = turns[0];
    if (!turn?.interact) throw new Error('no turn');

    await turn.interact.control({ type: 'click', selector: 'a.checkout' });
    env.commit(NEW); // lands after the click returned — inside the grace window

    expect(turn.signal?.aborted).toBe(false);
    // nav-clear's deferred wipe settles first (it reseeds the session mirror for NEW).
    await vi.waitFor(() => {
      const record = env.session['session:7'] as { changeset: { url: string } } | undefined;
      expect(record?.changeset.url).toBe(NEW);
    });

    expect((await recordEdit(turn)).ok).toBe(true);
    await vi.waitFor(() => {
      const record = env.session['changeset:7'] as
        | { changeset: { url: string; edits: unknown[] } }
        | undefined;
      expect(record?.changeset.url).toBe(NEW);
      expect(record?.changeset.edits).toHaveLength(1);
    });
    const mirror = env.session['session:7'] as { changeset: { edits: unknown[] } };
    expect(mirror.changeset.edits).toHaveLength(1); // what Ship reads
  });

  it('a commit with no agent interaction still aborts the turn', async () => {
    const env = boot();
    await start();
    await env.rpc({ type: 'user-message', text: 'make it pop' });
    const turn = turns[0];
    env.commit(NEW);
    expect(turn?.signal?.aborted).toBe(true);
  });
});

describe('tab closed mid-turn', () => {
  it('aborts the turn and refuses every later changeset write for that tab', async () => {
    const env = boot();
    await start();
    await env.rpc({ type: 'user-message', text: 'make it pop' });
    const turn = turns[0];
    if (!turn) throw new Error('no turn');

    env.closeTab();
    expect(turn.signal?.aborted).toBe(true);
    expect((await env.rpc({ type: 'session-get' })).turnRunning).toBe(false);

    await recordEdit(turn); // an in-flight tool call finishing after the close
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(env.session['changeset:7']).toBeUndefined();
  });
});

describe('Stop / newer Send during turn setup', () => {
  it('a Stop that lands while the turn resolves its tab is honoured', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const env = boot({
      query: async () => {
        calls++;
        if (calls === 1) await gate;
        return [{ id: 7, url: OLD }];
      },
    });
    await start();
    const sent = env.rpc({ type: 'user-message', text: 'make it pop' });
    await vi.waitFor(() => expect(calls).toBe(1));
    await env.rpc({ type: 'session-stop' });
    release();

    const ack = await sent;
    expect(ack.ok).toBe(false);
    expect(String(ack.error)).toContain('Stopped');
    expect(mocks.runTurn).not.toHaveBeenCalled();
  });

  it('an older turn still in setup can never abort the newer turn that superseded it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const env = boot({
      query: async () => {
        calls++;
        if (calls === 1) await gate;
        return [{ id: 7, url: OLD }];
      },
    });
    await start();
    const older = env.rpc({ type: 'user-message', text: 'first' });
    await vi.waitFor(() => expect(calls).toBe(1));
    const newer = await env.rpc({ type: 'user-message', text: 'second' });
    expect(newer.ok).toBe(true);
    release();

    expect((await older).ok).toBe(false);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.signal?.aborted).toBe(false);
  });
});

describe('injected stylesheets reach the changeset', () => {
  type Record7 = { changeset: { stylesheets: Array<{ id: string; css: string }> } } | undefined;

  it('a stylesheet-recorded push lands in the persisted record (mid-turn), and a revert(null) removes it (between turns)', async () => {
    const env = boot();
    await start();
    await env.rpc({ type: 'user-message', text: 'overhaul the design' });

    env.push({
      type: 'stylesheet-recorded',
      sheet: { id: 'default', css: ':root { --brand: #0af; }', intent: 'design system' },
    });
    await vi.waitFor(() => {
      expect((env.session['changeset:7'] as Record7)?.changeset.stylesheets).toEqual([
        { id: 'default', css: ':root { --brand: #0af; }', intent: 'design system' },
      ]);
      // …and in the SessionStore mirror Ship reads.
      expect((env.session['session:7'] as Record7)?.changeset.stylesheets).toHaveLength(1);
    });

    for (const done of finish) done(OUTCOME);
    await vi.waitFor(async () => {
      expect((await env.rpc({ type: 'session-get' })).turnRunning).toBe(false);
    });

    env.push({ type: 'stylesheet-reverted', id: 'default', css: null });
    await vi.waitFor(() => {
      expect((env.session['changeset:7'] as Record7)?.changeset.stylesheets).toEqual([]);
      expect((env.session['session:7'] as Record7)?.changeset.stylesheets).toEqual([]);
    });
  });

  it('a later turn can still undo a replacement recorded in an earlier turn (history carried into the turn store)', async () => {
    const env = boot();
    await start();
    const turnDone = async () => {
      for (const done of finish.splice(0)) done(OUTCOME);
      await vi.waitFor(async () => {
        expect((await env.rpc({ type: 'session-get' })).turnRunning).toBe(false);
      });
    };
    const sheets = () => (env.session['changeset:7'] as Record7)?.changeset.stylesheets;

    await env.rpc({ type: 'user-message', text: 'theme v1 then v2' });
    env.push({
      type: 'stylesheet-recorded',
      sheet: { id: 'default', css: 'a{color:red}', intent: 'theme' },
    });
    env.push({
      type: 'stylesheet-recorded',
      sheet: { id: 'default', css: 'a{color:blue}', intent: 'theme' },
    });
    await vi.waitFor(() => expect(sheets()?.[0]?.css).toBe('a{color:blue}'));
    await turnDone();

    // Second turn: the page-side undo restores v1 while this turn owns the store.
    await env.rpc({ type: 'user-message', text: 'undo that' });
    env.push({ type: 'stylesheet-reverted', id: 'default', css: 'a{color:red}' });
    await vi.waitFor(() => expect(sheets()?.[0]?.css).toBe('a{color:red}'));
    await turnDone();
  });
});

describe('escaped errors after the conversation is gone', () => {
  it('fall back to the SW-global ring instead of vanishing', async () => {
    const env = boot();
    await start();
    await env.rpc({ type: 'user-message', text: 'make it pop' }); // lastTurnTabId = 7
    env.closeTab(); // …whose session is then cleared
    await vi.waitFor(() => expect(env.session['session:7']).toBeUndefined());

    self.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: new Error('escaped-boom') }),
    );
    const log = await env.rpc({ type: 'debug-log-get' });
    expect(String(log.markdown)).toContain('escaped-boom');
  });
});
