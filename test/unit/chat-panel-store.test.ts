import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatMessage,
  nextUsage,
  reduceChat,
  ZERO_USAGE,
} from '@/entrypoints/sidepanel/stores/chat';
import type { Edit } from '@/shared/changeset';
import type { PanelToSw, StableSelector, SwToPanel } from '@/shared/messages';

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

  it('session-state stopped closes the in-flight bubble (no turn-done ever comes)', () => {
    // background.ts's `session-stop` clears `turnAbort` itself, so the aborted turn never emits
    // `turn-done`: without this the bubble — and its last tool chip — spun forever after Stop.
    let messages = reduceChat([], { type: 'token', text: 'working' });
    messages = reduceChat(messages, { type: 'session-state', state: 'stopped' });
    expect(messages[0]?.streaming).toBe(false);
  });

  it('a woken worker reporting turnRunning:false closes the orphaned bubble', () => {
    let messages = reduceChat([], { type: 'token', text: 'working' });
    messages = reduceChat(messages, {
      type: 'session-state',
      state: 'running',
      turnRunning: false,
    });
    expect(messages[0]?.streaming).toBe(false);
  });

  it('a plain running transition leaves a live turn alone', () => {
    let messages = reduceChat([], { type: 'token', text: 'working' });
    messages = reduceChat(messages, { type: 'session-state', state: 'running' });
    expect(messages[0]?.streaming).toBe(true);
    messages = reduceChat(messages, {
      type: 'session-state',
      state: 'running',
      turnRunning: true,
    });
    expect(messages[0]?.streaming).toBe(true);
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

describe('reduceChat: tool-result settles the chip that requested it', () => {
  const call = (tool: string, id?: string): SwToPanel => ({ type: 'tool-call', tool, id });

  it('matches by tool-call id when the SW carried one', () => {
    let messages = reduceChat([], call('setStyle', 'c1'));
    messages = reduceChat(messages, call('query', 'c2'));
    messages = reduceChat(messages, { type: 'tool-result', tool: 'setStyle', ok: true, id: 'c1' });
    expect(messages[0]?.toolCalls.map((c) => [c.tool, c.ok])).toEqual([
      ['setStyle', true],
      ['query', undefined],
    ]);
  });

  it('carries the failure reason onto the failed call', () => {
    let messages = reduceChat([], call('setStyle', 'c1'));
    messages = reduceChat(messages, {
      type: 'tool-result',
      tool: 'setStyle',
      ok: false,
      id: 'c1',
      error: 'no element matches #gone',
    });
    expect(messages[0]?.toolCalls[0]).toMatchObject({
      ok: false,
      error: 'no element matches #gone',
    });
  });

  it('with no id, settles the NEWEST unsettled call of that name', () => {
    let messages = reduceChat([], call('setStyle'));
    messages = reduceChat(messages, call('setStyle'));
    messages = reduceChat(messages, { type: 'tool-result', tool: 'setStyle', ok: false });
    expect(messages[0]?.toolCalls.map((c) => c.ok)).toEqual([undefined, false]);

    messages = reduceChat(messages, { type: 'tool-result', tool: 'setStyle', ok: true });
    expect(messages[0]?.toolCalls.map((c) => c.ok)).toEqual([true, false]);
  });

  it('never opens a bubble for a result with no call to attach to', () => {
    expect(reduceChat([], { type: 'tool-result', tool: 'setStyle', ok: true })).toEqual([]);
    const withUser: ChatMessage[] = [
      { id: 'u1', role: 'user', text: 'hi', toolCalls: [], edits: [], streaming: false },
    ];
    expect(reduceChat(withUser, { type: 'tool-result', tool: 'setStyle', ok: true })).toBe(
      withUser,
    );
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

// What the picker resolves and the composer's context chip displays — the referent of "this".
const pickedSelector: StableSelector = {
  value: '[data-testid="cta"]',
  strategy: 'data-attr',
  fragile: false,
};
const otherSelector: StableSelector = { value: '#hero', strategy: 'id', fragile: false };

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

  it('send() carries the picked element so "this" has a referent', async () => {
    // The signature bug: the picker resolved a target, the context chip showed it, and the turn
    // reached the SW as text alone — on a page with four CTAs the agent restyled a guess.
    vi.resetModules();
    const { sendMessage } = installChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    await store.send('make this 20% bigger', undefined, pickedSelector);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user-message', selector: pickedSelector }),
    );
  });

  it('send() carries the shift-multi-select set from the focus store', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(() => ({ ok: true }));
    const port = installPortFake();
    const focus = await import('@/entrypoints/sidepanel/stores/focus');
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    focus.initFocusStore();
    port.emit({ type: 'focus-multi', selectors: [pickedSelector, otherSelector] });
    await store.send('align these');

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ selectors: [pickedSelector, otherSelector] }),
    );
  });

  it('send() omits `selectors` entirely when nothing is multi-selected', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    await store.send('make the hero pink');

    const sent = sendMessage.mock.calls[0]?.[0] as PanelToSw & { selectors?: unknown };
    expect(sent.selectors).toBeUndefined();
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
