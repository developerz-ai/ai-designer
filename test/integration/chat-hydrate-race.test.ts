import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw, SwToPanel, ThreadViewMessage } from '@/shared/messages';

// Integration: the chat store's `thread-get` rebuild racing its own turn. Two cross-world races
// the Port + RPC seams can produce, both faked here so the store folds the real way:
//
//   • A tab switch MID-turn. The hydrate is pinned to the turn's tab while streaming, so it can
//     never move the view; without a remembered re-key the chat stayed on tab A after the turn
//     while the changeset followed tab B — and B's `edit-recorded` events were dropped as foreign.
//   • A hydrate landing while the `user-message` ack is still pending. The SW persists the user
//     turn before it acks, so the merged rebuild already holds it and the late ack appended it
//     a second time — a duplicate user bubble.

type Handler = (m: PanelToSw) => unknown;

interface Harness {
  emit: (m: SwToPanel) => void;
  activate: (tabId: number) => void;
}

function installChromeFake(handler: Handler): Harness {
  const listeners: Array<(m: unknown) => void> = [];
  const activated: Array<(info: { tabId: number; windowId: number }) => void> = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: vi.fn(async (m: unknown) => handler(m as PanelToSw)),
      connect: () => ({
        onMessage: { addListener: (f: (m: unknown) => void) => void listeners.push(f) },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
      }),
    },
    tabs: {
      onActivated: {
        addListener: (f: (info: { tabId: number; windowId: number }) => void) =>
          void activated.push(f),
      },
    },
  };
  return {
    emit: (m) => {
      for (const f of listeners) f(m);
    },
    activate: (tabId) => {
      for (const f of activated) f({ tabId, windowId: 1 });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('tab switch while a turn streams', () => {
  it('re-keys the chat to the active tab once the turn settles', async () => {
    let activeTab = 1;
    let running = false;
    const threads: Record<number, ThreadViewMessage[]> = {
      1: [{ role: 'user', text: 'A conv' }],
      2: [{ role: 'user', text: 'B conv' }],
    };
    const h = installChromeFake((m) => {
      if (m.type === 'session-get') {
        return running
          ? { ok: true, state: 'running', turnRunning: true, tabId: 1, currentTurnId: 't1' }
          : { ok: true, state: 'running', turnRunning: false, tabId: activeTab };
      }
      if (m.type === 'thread-get') {
        const tab = m.tabId ?? activeTab;
        return { ok: true, tabId: tab, thread: threads[tab] };
      }
      if (m.type === 'user-message') {
        running = true;
        return { ok: true, turnId: 't1' };
      }
      return { ok: true };
    });
    const chat = await import('@/entrypoints/sidepanel/stores/chat');
    chat.initChatStore();
    await flush();
    expect(chat.viewTabId()).toBe(1);

    await chat.send('go');
    h.emit({ type: 'token', text: 'hi', turnId: 't1' });
    activeTab = 2;
    h.activate(2);
    await flush();
    // Mid-turn the live turn outranks the switch — the transcript stays on the turn's tab.
    expect(chat.viewTabId()).toBe(1);

    running = false;
    h.emit({ type: 'turn-done', usage: { steps: 1, tokens: 1 }, turnId: 't1' });
    await flush();

    expect(chat.viewTabId()).toBe(2);
    expect(chat.messages().map((m) => m.text)).toEqual(['B conv']);
  });

  it('does not rebuild after the turn when the activated tab is the one already shown', async () => {
    let running = false;
    const thread: ThreadViewMessage[] = [];
    const h = installChromeFake((m) => {
      if (m.type === 'session-get') {
        return running
          ? { ok: true, state: 'running', turnRunning: true, tabId: 1, currentTurnId: 't1' }
          : { ok: true, state: 'running', turnRunning: false, tabId: 1 };
      }
      if (m.type === 'thread-get') return { ok: true, tabId: 1, thread: [...thread] };
      if (m.type === 'user-message') {
        running = true;
        thread.push({ role: 'user', text: 'go' }); // the assistant turn persists only at the end
        return { ok: true, turnId: 't1' };
      }
      return { ok: true };
    });
    const chat = await import('@/entrypoints/sidepanel/stores/chat');
    chat.initChatStore();
    await flush();

    await chat.send('go');
    h.emit({ type: 'token', text: 'hi', turnId: 't1' });
    h.activate(1);
    await flush();
    running = false;
    h.emit({ type: 'turn-done', usage: { steps: 1, tokens: 1 }, turnId: 't1' });
    await flush();

    // The streamed bubble survives — a post-turn rebuild from the persisted thread (which holds
    // only the user turn here) would have wiped it.
    expect(chat.messages().map((m) => [m.role, m.text])).toEqual([
      ['user', 'go'],
      ['assistant', 'hi'],
    ]);
  });
});

describe('hydrate landing while the send ack is pending', () => {
  it('renders the user message once, not twice', async () => {
    let running = false;
    const thread: ThreadViewMessage[] = [];
    let releaseAck: (v: unknown) => void = () => {};
    installChromeFake((m) => {
      if (m.type === 'session-get') {
        return running
          ? { ok: true, state: 'running', turnRunning: true, tabId: 1, currentTurnId: 't1' }
          : { ok: true, state: 'running', turnRunning: false, tabId: 1 };
      }
      if (m.type === 'thread-get') return { ok: true, tabId: 1, thread: [...thread] };
      if (m.type === 'user-message') {
        running = true;
        thread.push({ role: 'user', text: 'go' }); // persisted BEFORE the ack goes out
        return new Promise((r) => {
          releaseAck = r;
        });
      }
      return { ok: true };
    });
    const chat = await import('@/entrypoints/sidepanel/stores/chat');
    chat.initChatStore();
    await flush();

    const pending = chat.send('go');
    await flush();
    await chat.hydrateThread(); // a reconnect / tab focus while the ack is in flight
    releaseAck({ ok: true, turnId: 't1' });
    expect(await pending).toBe(true);

    expect(chat.messages().map((m) => [m.role, m.text])).toEqual([['user', 'go']]);
  });

  it('still appends when no merge ran during the ack (an identical earlier message stays)', async () => {
    installChromeFake((m) => {
      if (m.type === 'session-get') {
        return { ok: true, state: 'running', turnRunning: false, tabId: 1 };
      }
      if (m.type === 'thread-get')
        return { ok: true, tabId: 1, thread: [{ role: 'user', text: 'go' }] };
      if (m.type === 'user-message') return { ok: true, turnId: 't2' };
      return { ok: true };
    });
    const chat = await import('@/entrypoints/sidepanel/stores/chat');
    chat.initChatStore();
    await flush();

    await chat.send('go');

    expect(chat.messages().map((m) => [m.role, m.text])).toEqual([
      ['user', 'go'],
      ['user', 'go'],
    ]);
  });
});

describe('stopTurn', () => {
  it('surfaces a refused stop instead of treating { ok: false } as success', async () => {
    installChromeFake((m) =>
      m.type === 'session-stop'
        ? { ok: false, error: 'no session' }
        : m.type === 'session-get'
          ? { ok: true, state: 'idle', turnRunning: false, tabId: null }
          : { ok: false },
    );
    const chat = await import('@/entrypoints/sidepanel/stores/chat');

    await chat.stopTurn();

    expect(chat.error()).toBe('no session');
  });
});
