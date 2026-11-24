import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw, SwToPanel } from '@/shared/messages';

// The chat store's `newConversation()` — the panel half of the `conversation-new` RPC. What has to
// hold: the LOCAL transcript resets only after the SW acks (the SW is the one archiving the thread
// to history — wiping the replica first would show an empty chat for a conversation the SW then
// refused to reset), the turn key drops so a late event from the aborted turn can't resurrect a
// bubble, and a SUBSEQUENT turn folds into a genuinely fresh thread. Harness mirrors
// chat-panel-store.test.ts (fake chrome.runtime + Port, module reset per test).

type SendMessage = (msg: PanelToSw) => unknown;

function installChromeFake(handle: SendMessage): { sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn(async (msg: unknown) => handle(msg as PanelToSw));
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
  return { sendMessage };
}

/** Default RPC handler: user-message acks ok with a turnId; the hydration RPCs reply a malformed
 *  shape on purpose so `hydrateThread` no-ops and the stream tests stay deterministic. */
function ackHandler(
  over: Partial<Record<PanelToSw['type'], (msg: PanelToSw) => unknown>> = {},
): SendMessage {
  return (msg) => {
    const handler = over[msg.type];
    if (handler) return handler(msg);
    if (msg.type === 'user-message') return { ok: true, turnId: 't1' };
    return { ok: true };
  };
}

function installPortFake(): { emit: (msg: SwToPanel) => void } {
  const listeners: Array<(msg: unknown) => void> = [];
  const port = {
    onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.push(fn) },
    onDisconnect: { addListener: (_fn: () => void) => {} },
    postMessage: () => {},
  };
  const chromeFake = (globalThis as { chrome?: { runtime?: Record<string, unknown> } }).chrome;
  if (chromeFake?.runtime) {
    chromeFake.runtime.connect = () => port;
  }
  return {
    emit: (msg) => {
      for (const fn of listeners) fn(msg);
    },
  };
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('chat store: newConversation resets the local transcript', () => {
  it('dispatches conversation-new and wipes messages, turn key, streaming and usage on ack', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(ackHandler());
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('make it pop');
    port.emit({ type: 'token', text: 'done', turnId: 't1' });
    port.emit({ type: 'turn-done', usage: { steps: 2, tokens: 900 }, turnId: 't1' });
    expect(store.messages()).toHaveLength(2);
    expect(store.usage()).toEqual({ steps: 2, tokens: 900 });

    await expect(store.newConversation()).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation-new' }));
    expect(store.messages()).toEqual([]);
    expect(store.streaming()).toBe(false);
    expect(store.activeTurnId()).toBeNull();
    expect(store.usage()).toEqual(store.ZERO_USAGE);
    expect(store.error()).toBeNull();
  });

  it('pins the RPC to the conversation tab the panel is keyed to, like copyDebugLog', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(
      ackHandler({
        'session-get': () => ({ ok: true, state: 'running', turnRunning: false, tabId: 7 }),
        'thread-get': () => ({ ok: true, tabId: 7, thread: [] }),
      }),
    );
    installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.hydrateThread();
    expect(store.viewTabId()).toBe(7);

    await store.newConversation();

    expect(sendMessage).toHaveBeenCalledWith({ type: 'conversation-new', tabId: 7 });
  });

  it("mid-turn: resets even while streaming, and the aborted turn's late events no longer fold", async () => {
    vi.resetModules();
    installChromeFake(ackHandler());
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('go');
    port.emit({ type: 'token', text: 'streaming…', turnId: 't1' });
    expect(store.streaming()).toBe(true);

    await store.newConversation();

    expect(store.messages()).toEqual([]);
    expect(store.streaming()).toBe(false);

    // A straggler from the aborted turn (the SW stamps everything it still emits with t1) must
    // not resurrect a bubble in the fresh conversation.
    port.emit({ type: 'token', text: 'zombie', turnId: 't1' });
    expect(store.messages()).toEqual([]);
  });

  it('a subsequent turn folds into a fresh thread', async () => {
    vi.resetModules();
    installChromeFake(
      ackHandler({
        // Distinct turn ids per send so the second turn is recognisably its own.
        'user-message': (() => {
          let n = 0;
          return () => ({ ok: true, turnId: `t${++n}` });
        })(),
      }),
    );
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('first conversation');
    port.emit({ type: 'token', text: 'old reply', turnId: 't1' });
    port.emit({ type: 'turn-done', usage: { steps: 1, tokens: 100 }, turnId: 't1' });

    await store.newConversation();

    await store.send('second conversation');
    port.emit({ type: 'token', text: 'new reply', turnId: 't2' });

    // Nothing of the archived thread remains — the new turn IS the whole transcript.
    expect(store.messages().map((m) => [m.role, m.text])).toEqual([
      ['user', 'second conversation'],
      ['assistant', 'new reply'],
    ]);
    expect(store.activeTurnId()).toBe('t2');
  });

  it('a send whose ack the reset beat cannot resurrect its bubble in the fresh transcript', async () => {
    vi.resetModules();
    // The user-message ack is HELD until after the reset resolves — the sendMessage reply and the
    // reset are unordered, and the delayed ack used to append its bubble to the empty transcript
    // and re-key the panel to a turn the SW already aborted.
    let releaseAck: (v: unknown) => void = () => {};
    installChromeFake((msg) => {
      if (msg.type === 'user-message')
        return new Promise((resolve) => {
          releaseAck = resolve;
        });
      return ackHandler()(msg);
    });
    installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    const pendingSend = store.send('beaten by the reset');
    await expect(store.newConversation()).resolves.toBe(true);
    expect(store.messages()).toEqual([]);

    releaseAck({ ok: true, turnId: 't-late' });
    await expect(pendingSend).resolves.toBe(false);

    expect(store.messages()).toEqual([]); // the reset-away bubble stays gone
    expect(store.activeTurnId()).toBeNull();
    expect(store.streaming()).toBe(false);
  });

  it('a refused reset leaves the transcript untouched and surfaces the reason', async () => {
    vi.resetModules();
    installChromeFake(ackHandler({ 'conversation-new': () => ({ ok: false, error: 'no tab' }) }));
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('keep me');
    port.emit({ type: 'token', text: 'reply', turnId: 't1' });
    port.emit({ type: 'turn-done', usage: { steps: 1, tokens: 10 }, turnId: 't1' });

    await expect(store.newConversation()).resolves.toBe(false);

    expect(store.messages().map((m) => m.text)).toEqual(['keep me', 'reply']);
    expect(store.error()).toBe('no tab');
  });

  it('a transport failure is surfaced, never thrown', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'conversation-new') throw new Error('port closed');
      return ackHandler()(msg);
    });
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('keep me');
    port.emit({ type: 'turn-done', usage: { steps: 1, tokens: 10 }, turnId: 't1' });

    await expect(store.newConversation()).resolves.toBe(false);
    expect(store.error()).toBe('port closed');
    expect(store.messages()).toHaveLength(1); // transcript intact
  });
});
