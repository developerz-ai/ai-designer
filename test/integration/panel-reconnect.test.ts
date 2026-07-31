import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw, SwToPanel } from '@/shared/messages';

// Integration (#165 S5): what a panel knows AFTER it (re)connects to a service worker it did not
// start with. Two failures live here, both cross-world:
//
//   • Re-opening the panel mid-turn. Module state died with the last panel, so the session store
//     started at `idle`, App rendered the pre-Start hint, and the only button on that screen —
//     Start — is a NEW session to background.ts, which aborts the turn still running on the page.
//     Fix: the session store hydrates (`session-get`) exactly as the readiness store does, and the
//     chat store subscribes from App, not from the tab that the hydration gates.
//   • A Port dropped mid-session. Subscribers survive the reconnect (transport.test.ts pins that),
//     but the SNAPSHOTS do not: the SW's MCP health and readiness are in-memory and reset with the
//     worker, so the panel kept rendering "connected" — hiding McpPanel's Connect button — with
//     nothing able to restore truth until the tab remounted.
//
// The Port and the RPC channel are the cross-world seams, so both are faked; every store folds the
// real way.

interface FakePort {
  onMessage: { addListener: (fn: (raw: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  emit: (raw: unknown) => void;
  disconnect: () => void;
}

function makePort(): FakePort {
  const onMsg: Array<(raw: unknown) => void> = [];
  const onDisc: Array<() => void> = [];
  return {
    onMessage: { addListener: (fn) => void onMsg.push(fn) },
    onDisconnect: { addListener: (fn) => void onDisc.push(fn) },
    emit: (raw) => {
      for (const fn of onMsg) fn(raw);
    },
    disconnect: () => {
      for (const fn of onDisc) fn();
    },
  };
}

let ports: FakePort[] = [];
let sent: PanelToSw[] = [];
const latest = () => ports[ports.length - 1] as FakePort;
const sentTypes = () => sent.map((m) => m.type);

/** The SW stand-in: a worker woken AFTER it died mid-turn — it persisted the lifecycle
 *  (`running`) but has no live turn, which is exactly what closes the orphaned bubble. */
function installChromeFake(reply: (msg: PanelToSw) => unknown): void {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      connect: () => {
        const p = makePort();
        ports.push(p);
        return p;
      },
      sendMessage: vi.fn(async (msg: unknown) => {
        sent.push(msg as PanelToSw);
        return reply(msg as PanelToSw);
      }),
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  ports = [];
  sent = [];
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('panel reopened while a turn is running', () => {
  it('hydrates the session lifecycle instead of showing the pre-Start screen', async () => {
    installChromeFake((msg) =>
      msg.type === 'session-get'
        ? { ok: true, state: 'running', turnRunning: true, tabId: 7 }
        : { ok: true },
    );
    const session = await import('@/entrypoints/sidepanel/stores/session');

    session.initSessionStore();
    await vi.waitFor(() => expect(session.sessionState()).toBe('running'));
    // App's gate is `sessionState() !== 'idle'` — this is what keeps ChatPanel mounted, and what
    // keeps the user away from a Start button that would abort the live turn.
    expect(sentTypes()).toContain('session-get');
  });

  it('closes an orphaned bubble when the woken worker reports no turn in flight', async () => {
    installChromeFake((msg) =>
      msg.type === 'session-get'
        ? { ok: true, state: 'running', turnRunning: false, tabId: 7 }
        : { ok: true },
    );
    const chat = await import('@/entrypoints/sidepanel/stores/chat');
    const session = await import('@/entrypoints/sidepanel/stores/session');

    // The chat store subscribes from App's onMount — NOT from the tab whose mount the session
    // state gates — so the transcript of a still-running turn keeps assembling either way.
    chat.initChatStore();
    await chat.send('make the hero bigger');
    latest().emit({ type: 'token', text: 'working' } satisfies SwToPanel);
    expect(chat.messages().at(-1)?.streaming).toBe(true);

    session.initSessionStore();

    // #168: `turnRunning: false` no longer closes the bubble on FIRST sight — a reconnect can
    // beat the woken worker's turn re-registration, and killing the stream on that race
    // re-enabled send mid-turn. The store re-asks (`session-get`) after the liveness delay and
    // only the CONFIRMED not-running answer closes it.
    await vi.advanceTimersByTimeAsync(chat.TURN_LIVENESS_DELAY_MS);
    await vi.waitFor(() => expect(chat.messages().at(-1)?.streaming).toBe(false));
    expect(chat.streaming()).toBe(false);
    // The text streamed before the worker died is kept — the bubble is closed, not dropped.
    expect(chat.messages().at(-1)?.text).toBe('working');
  });

  it('initChatStore is idempotent — App and ChatPanel both call it, one subscription results', async () => {
    installChromeFake(() => ({ ok: true }));
    const chat = await import('@/entrypoints/sidepanel/stores/chat');

    chat.initChatStore();
    chat.initChatStore();
    latest().emit({ type: 'token', text: 'hi' } satisfies SwToPanel);

    expect(chat.messages()).toHaveLength(1);
    expect(chat.messages()[0]?.text).toBe('hi');
  });
});

describe('transcript rebuild via thread-get (#168)', () => {
  const threadReply = {
    ok: true,
    tabId: 7,
    thread: [
      { role: 'user', text: 'make the hero bigger' },
      { role: 'assistant', text: 'Enlarged it.', tools: [{ name: 'setStyle', ok: true }] },
    ],
  };

  it('rebuilds the transcript from the SW thread on mount, everything closed', async () => {
    installChromeFake((msg) => {
      switch (msg.type) {
        case 'session-get':
          return { ok: true, state: 'running', turnRunning: false, tabId: 7 };
        case 'thread-get':
          return threadReply;
        default:
          return { ok: true };
      }
    });
    const chat = await import('@/entrypoints/sidepanel/stores/chat');

    chat.initChatStore();
    await vi.waitFor(() => expect(chat.messages()).toHaveLength(2));

    // The SW thread replaced the (empty) local replica wholesale: closed bubbles, settled chips.
    expect(chat.messages()[0]).toMatchObject({ role: 'user', text: 'make the hero bigger' });
    expect(chat.messages()[1]).toMatchObject({
      role: 'assistant',
      text: 'Enlarged it.',
      streaming: false,
      toolCalls: [{ tool: 'setStyle', ok: true }],
    });
    expect(chat.viewTabId()).toBe(7);
  });

  it('re-pulls the thread after a dropped Port — the transcript survives an SW eviction', async () => {
    installChromeFake((msg) => {
      switch (msg.type) {
        case 'session-get':
          return { ok: true, state: 'running', turnRunning: false, tabId: 7 };
        case 'thread-get':
          return threadReply;
        default:
          return { ok: true };
      }
    });
    const chat = await import('@/entrypoints/sidepanel/stores/chat');

    chat.initChatStore();
    await vi.waitFor(() => expect(sentTypes()).toContain('thread-get'));
    sent = [];

    latest().disconnect(); // Chrome force-disconnects the Port after ~5 minutes
    vi.advanceTimersByTime(500); // the sw-stream reconnect backoff

    // The chat store's onReconnect hydration re-reads the SW's per-tab thread, exactly like
    // readiness/MCP re-read their snapshots below.
    await vi.waitFor(() => expect(sentTypes()).toContain('thread-get'));
    expect(chat.messages()).toHaveLength(2);
  });
});

describe('port reconnect re-hydrates every snapshot', () => {
  it('re-pulls readiness, MCP health and the session lifecycle after a dropped Port', async () => {
    installChromeFake((msg) => {
      switch (msg.type) {
        case 'readiness':
          return {
            ok: true,
            state: {
              provider: 'ok',
              model: 'ok',
              hostPermission: 'granted',
              mcp: { connected: 0, total: 1 },
              ready: true,
            },
          };
        case 'mcp-list':
          return { ok: true, servers: [] };
        case 'session-get':
          return { ok: true, state: 'idle', turnRunning: false, tabId: null };
        default:
          return { ok: true };
      }
    });
    const readiness = await import('@/entrypoints/sidepanel/stores/readiness');
    const mcp = await import('@/entrypoints/sidepanel/stores/mcp');
    const session = await import('@/entrypoints/sidepanel/stores/session');

    readiness.initReadinessStore();
    mcp.initMcpStore();
    session.initSessionStore();
    await vi.waitFor(() => expect(sentTypes()).toContain('readiness'));
    sent = [];

    latest().disconnect(); // Chrome force-disconnects the Port after ~5 minutes
    vi.advanceTimersByTime(500); // the sw-stream reconnect backoff

    await vi.waitFor(() => {
      // Every in-memory SW fact the panel renders, re-read on the fresh Port. Without this the
      // MCP row stayed green (Connect button hidden) and readiness still claimed "1/1 connected".
      expect(sentTypes()).toContain('readiness');
      expect(sentTypes()).toContain('mcp-list');
      expect(sentTypes()).toContain('session-get');
    });
  });

  it('does not double-hydrate on the FIRST connect', async () => {
    installChromeFake((msg) =>
      msg.type === 'readiness'
        ? {
            ok: true,
            state: {
              provider: 'missing',
              model: 'missing',
              hostPermission: 'needed',
              mcp: { connected: 0, total: 0 },
              ready: false,
            },
          }
        : { ok: true },
    );
    const readiness = await import('@/entrypoints/sidepanel/stores/readiness');

    readiness.initReadinessStore();
    await vi.waitFor(() => expect(sentTypes()).toContain('readiness'));

    expect(sentTypes().filter((t) => t === 'readiness')).toHaveLength(1);
  });
});
