import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatMessage,
  nextUsage,
  reduceChat,
  ZERO_USAGE,
} from '@/entrypoints/sidepanel/stores/chat';
import type { Edit } from '@/shared/changeset';
import type { PanelToSw, SwToPanel } from '@/shared/messages';

// Pure fold: mirrors test/unit/mcp-panel-store.test.ts's reduceServers coverage — no chrome, no
// Solid mount required.

const edit: Edit = {
  intent: 'recolor',
  selector: { value: '#hero', strategy: 'id', fragile: false },
  changes: [{ prop: 'color', before: null, after: '#000' }],
  attrs: [],
  classes: [],
  frameworkHints: [],
};

/** `turn-done` fixture — carries the session's cumulative spend (`usage`), required since #25. */
const turnDone = (steps = 0, tokens = 0): SwToPanel => ({
  type: 'turn-done',
  usage: { steps, tokens },
});

describe('reduceChat: streaming assembly', () => {
  it('starts a new streaming assistant bubble on the first token', () => {
    const next = reduceChat([], { type: 'token', text: 'Hel' });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ role: 'assistant', text: 'Hel', streaming: true });
  });

  it('appends further tokens onto the same in-flight bubble', () => {
    let messages = reduceChat([], { type: 'token', text: 'Hel' });
    messages = reduceChat(messages, { type: 'token', text: 'lo' });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('Hello');
  });

  it('a tool-call before any token still opens (or reuses) the in-flight bubble', () => {
    const next = reduceChat([], {
      type: 'tool-call',
      tool: 'setStyle',
      selector: '#hero',
      kind: 'act',
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.toolCalls).toEqual([{ tool: 'setStyle', selector: '#hero', kind: 'act' }]);
    expect(next[0]?.streaming).toBe(true);
  });

  it('edit-recorded appends onto the in-flight bubble', () => {
    let messages = reduceChat([], { type: 'token', text: 'ok' });
    messages = reduceChat(messages, { type: 'edit-recorded', edit });
    expect(messages[0]?.edits).toEqual([edit]);
  });

  it('turn-done closes the in-flight bubble and is idempotent', () => {
    let messages = reduceChat([], { type: 'token', text: 'ok' });
    messages = reduceChat(messages, turnDone());
    expect(messages[0]?.streaming).toBe(false);

    const again = reduceChat(messages, turnDone());
    expect(again).toEqual(messages); // no-op: nothing was in flight
  });

  it('a new token after turn-done starts a fresh bubble rather than reopening the old one', () => {
    let messages = reduceChat([], { type: 'token', text: 'first' });
    messages = reduceChat(messages, turnDone());
    messages = reduceChat(messages, { type: 'token', text: 'second' });
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.text)).toEqual(['first', 'second']);
    expect(messages[1]?.streaming).toBe(true);
  });

  it('error attaches to the in-flight bubble and closes it out even mid-stream', () => {
    let messages = reduceChat([], { type: 'token', text: 'partial' });
    messages = reduceChat(messages, { type: 'error', message: 'boom' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: 'partial', error: 'boom', streaming: false });
  });

  it('error with no prior stream still creates a closed (non-streaming) bubble', () => {
    const messages = reduceChat([], { type: 'error', message: 'Add a provider first.' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      text: '',
      error: 'Add a provider first.',
      streaming: false,
    });
  });

  it('a subsequent turn-done after error is a no-op (already closed)', () => {
    let messages = reduceChat([], { type: 'error', message: 'boom' });
    const before = messages;
    messages = reduceChat(messages, turnDone());
    expect(messages).toEqual(before);
  });

  it('ignores unrelated message types', () => {
    const msg = { type: 'mcp-status' } as unknown as SwToPanel;
    expect(reduceChat([], msg)).toEqual([]);
  });

  it('is pure — never mutates the input array or its entries', () => {
    const seed: ChatMessage[] = reduceChat([], { type: 'token', text: 'a' });
    const before = JSON.parse(JSON.stringify(seed));
    reduceChat(seed, { type: 'token', text: 'b' });
    expect(seed).toEqual(before);
  });

  it('a user message never gets folded into and closes any in-flight assistant bubble', () => {
    // reduceChat itself only ever produces assistant bubbles; user bubbles are appended by
    // send() directly. Verify the fold leaves an externally-appended user entry alone.
    const withUser: ChatMessage[] = [
      { id: 'u1', role: 'user', text: 'hi', toolCalls: [], edits: [], streaming: false },
    ];
    const next = reduceChat(withUser, { type: 'token', text: 'hello' });
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(withUser[0]);
    expect(next[1]).toMatchObject({ role: 'assistant', text: 'hello' });
  });
});

describe('nextUsage: session usage meter fold', () => {
  it('adopts the cumulative usage carried on turn-done', () => {
    expect(nextUsage(ZERO_USAGE, turnDone(3, 1200))).toEqual({ steps: 3, tokens: 1200 });
  });

  it('replaces rather than accumulates — turn-done already carries the running total', () => {
    const prev = { steps: 3, tokens: 1200 };
    expect(nextUsage(prev, turnDone(5, 2000))).toEqual({ steps: 5, tokens: 2000 });
  });

  it('leaves the total unchanged for any non-turn-done message', () => {
    const prev = { steps: 3, tokens: 1200 };
    expect(nextUsage(prev, { type: 'token', text: 'hi' })).toBe(prev);
    expect(nextUsage(prev, { type: 'error', message: 'boom' })).toBe(prev);
  });
});

// RPC-level coverage: dispatch-only actions round-trip through chrome.runtime.sendMessage (fake, no
// real extension context), mirroring test/unit/changeset-panel-store.test.ts's pattern.
type SendMessage = (msg: PanelToSw) => unknown;

function installChromeFake(handle: SendMessage): { sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn(async (msg: unknown) => handle(msg as PanelToSw));
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
  return { sendMessage };
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('chat store actions', () => {
  it('send() appends the user message immediately and dispatches user-message', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    const pending = store.send('make the hero pink');
    expect(store.messages()).toHaveLength(1);
    expect(store.messages()[0]).toMatchObject({ role: 'user', text: 'make the hero pink' });
    expect(store.streaming()).toBe(true);

    await pending;
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user-message', text: 'make the hero pink' }),
    );
  });

  it('send() ignores a blank/whitespace-only draft', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    await store.send('   ');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.messages()).toEqual([]);
  });

  it('send() supersedes a prior in-flight assistant bubble (closes it, not drop it)', async () => {
    vi.resetModules();
    installChromeFake(() => ({ ok: true }));
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('first');
    port.emit({ type: 'token', text: 'working…' }); // turn still in flight when the user follows up

    await store.send('second');
    const shape = store.messages().map((m) => [m.role, m.text, m.streaming]);
    expect(shape).toEqual([
      ['user', 'first', false],
      ['assistant', 'working…', false], // closed out, not dropped, by the newer send()
      ['user', 'second', false],
    ]);
  });

  it('a rejected dispatch surfaces its message and clears streaming', async () => {
    vi.resetModules();
    installChromeFake(() => {
      throw new Error('port closed');
    });
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    await store.send('hi');

    expect(store.error()).toBe('port closed');
    expect(store.streaming()).toBe(false);
  });

  it('stopTurn() dispatches session-stop', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    await store.stopTurn();

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'session-stop' }));
  });

  it('clearChat() resets the thread, streaming, and error', async () => {
    vi.resetModules();
    installChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    await store.send('hi');
    store.clearChat();

    expect(store.messages()).toEqual([]);
    expect(store.streaming()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('initChatStore() folds a live turn-done push into streaming=false', async () => {
    vi.resetModules();
    installChromeFake(() => ({ ok: true }));
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('hi');
    expect(store.streaming()).toBe(true);

    port.emit({ type: 'token', text: 'working on it' });
    expect(store.messages().at(-1)?.text).toBe('working on it');

    port.emit(turnDone(2, 900));
    expect(store.streaming()).toBe(false);
    expect(store.messages().at(-1)?.streaming).toBe(false);
    expect(store.usage()).toEqual({ steps: 2, tokens: 900 });
  });
});

// Minimal chrome.runtime.connect Port fake so `connectPort()`/`subscribeToSw()` (stores/sw-stream.ts)
// have something to attach listeners to, mirroring the shape used by test/unit/focus.test.ts-style
// stream stores. `emit` drives the registered onMessage listener as the SW would over the real Port.
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
