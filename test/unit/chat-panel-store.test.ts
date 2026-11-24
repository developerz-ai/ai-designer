import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatMessage,
  classifyEvent,
  type EventContext,
  keepsLocalTurn,
  mergeInFlight,
  nextUsage,
  reduceChat,
  threadToMessages,
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

/** `turn-done` fixture — carries the session's cumulative spend (`usage`), required since #25.
 *  `turnId` stamps it for attribution (#168); omitted = a pre-#168 emitter. */
const turnDone = (steps = 0, tokens = 0, turnId?: string): SwToPanel => ({
  type: 'turn-done',
  usage: { steps, tokens },
  turnId,
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
    // classifyEvent has already vetted the error as belonging to this view by the time it reaches
    // the fold — so the fold's job stays: attach + terminate.
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

  it('a running push with turnRunning:false leaves the bubble alone (deferred verification)', () => {
    // #168 finding 2: a reconnect can reach a fresh worker BEFORE it re-registers the in-flight
    // turn — its first `turnRunning: false` must not kill the live bubble. The STORE verifies via
    // a delayed session-get (see the liveness tests below); the fold itself stays hands-off.
    let messages = reduceChat([], { type: 'token', text: 'working' });
    messages = reduceChat(messages, {
      type: 'session-state',
      state: 'running',
      turnRunning: false,
    });
    expect(messages[0]?.streaming).toBe(true);
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
      {
        id: 'u1',
        role: 'user',
        segments: [{ kind: 'text', text: 'hi' }],
        text: 'hi',
        toolCalls: [],
        edits: [],
        streaming: false,
      },
    ];
    const next = reduceChat(withUser, { type: 'token', text: 'hello' });
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(withUser[0]);
    expect(next[1]).toMatchObject({ role: 'assistant', text: 'hello' });
  });
});

describe('reduceChat: ordered segments (prose ↔ tool bursts)', () => {
  // The model alternates text → tool calls → text → tool calls…; the bubble's `segments` record
  // that true order. `text`/`toolCalls` stay as DERIVED flat views of the same content.

  it('token → tool-call → token produces [text, tools, text]', () => {
    let messages = reduceChat([], { type: 'token', text: 'Let me look. ' });
    messages = reduceChat(messages, { type: 'tool-call', tool: 'pageFacts', kind: 'read' });
    messages = reduceChat(messages, { type: 'token', text: 'Found it.' });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.segments).toEqual([
      { kind: 'text', text: 'Let me look. ' },
      { kind: 'tools', calls: [{ tool: 'pageFacts', kind: 'read' }] },
      { kind: 'text', text: 'Found it.' },
    ]);
    // The flat views stay a faithful flattening of the ordered truth.
    expect(messages[0]?.text).toBe('Let me look. Found it.');
    expect(messages[0]?.toolCalls).toEqual([{ tool: 'pageFacts', kind: 'read' }]);
  });

  it('a second tool-call right after the first joins the SAME tools segment', () => {
    let messages = reduceChat([], { type: 'token', text: 'Two edits: ' });
    messages = reduceChat(messages, { type: 'tool-call', tool: 'setStyle', kind: 'act' });
    messages = reduceChat(messages, { type: 'tool-call', tool: 'setAttr', kind: 'act' });

    expect(messages[0]?.segments).toEqual([
      { kind: 'text', text: 'Two edits: ' },
      {
        kind: 'tools',
        calls: [
          { tool: 'setStyle', kind: 'act' },
          { tool: 'setAttr', kind: 'act' },
        ],
      },
    ]);
  });

  it('further tokens grow the trailing text segment instead of opening a new one per token', () => {
    let messages = reduceChat([], { type: 'tool-call', tool: 'pageFacts' });
    messages = reduceChat(messages, { type: 'token', text: 'Fou' });
    messages = reduceChat(messages, { type: 'token', text: 'nd it.' });

    expect(messages[0]?.segments).toEqual([
      { kind: 'tools', calls: [{ tool: 'pageFacts' }] },
      { kind: 'text', text: 'Found it.' },
    ]);
  });

  it('a tool-result settles its call by id inside an EARLIER segment', () => {
    let messages = reduceChat([], { type: 'tool-call', tool: 'setStyle', id: 'a' });
    messages = reduceChat(messages, { type: 'token', text: 'That failed — retrying. ' });
    messages = reduceChat(messages, { type: 'tool-call', tool: 'setStyle', id: 'b' });
    messages = reduceChat(messages, {
      type: 'tool-result',
      tool: 'setStyle',
      ok: false,
      error: 'stale selector',
      id: 'a',
    });

    const segments = messages[0]?.segments;
    expect(segments?.[0]).toEqual({
      kind: 'tools',
      calls: [{ tool: 'setStyle', id: 'a', ok: false, error: 'stale selector' }],
    });
    // The later burst's call is untouched — still awaiting its own result.
    expect(segments?.[2]).toEqual({ kind: 'tools', calls: [{ tool: 'setStyle', id: 'b' }] });
    // And the flat view carries the settled outcome in the same order.
    expect(messages[0]?.toolCalls).toEqual([
      { tool: 'setStyle', id: 'a', ok: false, error: 'stale selector' },
      { tool: 'setStyle', id: 'b' },
    ]);
  });

  it('an id-less tool-result settles the NEWEST unsettled same-name call across segments', () => {
    let messages = reduceChat([], { type: 'tool-call', tool: 'setStyle' });
    messages = reduceChat(messages, { type: 'token', text: 'again ' });
    messages = reduceChat(messages, { type: 'tool-call', tool: 'setStyle' });
    messages = reduceChat(messages, { type: 'tool-result', tool: 'setStyle', ok: true });

    const segments = messages[0]?.segments;
    expect(segments?.[0]).toEqual({ kind: 'tools', calls: [{ tool: 'setStyle' }] });
    expect(segments?.[2]).toEqual({ kind: 'tools', calls: [{ tool: 'setStyle', ok: true }] });
  });

  it('segment folding is pure — earlier segments keep their identity while the tail grows', () => {
    let messages = reduceChat([], { type: 'token', text: 'first ' });
    messages = reduceChat(messages, { type: 'tool-call', tool: 'query' });
    const firstText = messages[0]?.segments[0];
    const before = JSON.parse(JSON.stringify(messages));

    const next = reduceChat(messages, { type: 'token', text: 'second' });

    expect(messages).toEqual(before); // input untouched
    // Position-keyed rendering (Message.tsx uses Index) relies on untouched positions keeping
    // their object identity so streaming never remounts an earlier segment's subtree.
    expect(next[0]?.segments[0]).toBe(firstText);
  });
});

describe('classifyEvent: turn/tab attribution gate (#168)', () => {
  const ctx = (over: Partial<EventContext> = {}): EventContext => ({
    activeTurnId: 't1',
    streaming: true,
    viewTabId: 1,
    ...over,
  });

  it('folds a stream event stamped with the active turn', () => {
    expect(classifyEvent({ type: 'token', text: 'x', turnId: 't1' }, ctx())).toBe('fold');
    expect(classifyEvent(turnDone(1, 10, 't1'), ctx())).toBe('fold');
  });

  it("drops a foreign turn's token/tool events instead of mutating this transcript", () => {
    // Finding 4: two windows share the SW's broadcast — the second panel grew orphan bubbles.
    expect(classifyEvent({ type: 'token', text: 'x', turnId: 't2' }, ctx())).toBe('drop');
    expect(classifyEvent({ type: 'tool-call', tool: 'setStyle', turnId: 't2' }, ctx())).toBe(
      'drop',
    );
    expect(
      classifyEvent({ type: 'tool-result', tool: 'setStyle', ok: true, turnId: 't2' }, ctx()),
    ).toBe('drop');
  });

  it('drops a foreign turn-done — its usage must not be adopted', () => {
    expect(classifyEvent(turnDone(9, 9999, 't2'), ctx())).toBe('drop');
  });

  it('drops a stamped event when this panel has no keyed turn at all', () => {
    expect(
      classifyEvent({ type: 'token', text: 'x', turnId: 't2' }, ctx({ activeTurnId: null })),
    ).toBe('drop');
  });

  it('folds unstamped events regardless of the active turn (pre-#168 SW keeps working)', () => {
    expect(classifyEvent({ type: 'token', text: 'x' }, ctx())).toBe('fold');
    expect(classifyEvent({ type: 'token', text: 'x' }, ctx({ activeTurnId: null }))).toBe('fold');
    expect(classifyEvent(turnDone(), ctx({ activeTurnId: null, streaming: false }))).toBe('fold');
  });

  it('an unattributed error during a live turn is a notice, never a stream-terminator', () => {
    // Finding 1: ship-route/history-append failures pushed `error` mid-turn and closed the live
    // bubble. Pre-fix this classified as 'fold' (terminal) — this test fails against that.
    expect(classifyEvent({ type: 'error', message: 'ship failed' }, ctx())).toBe('notice');
  });

  it('an unattributed error while idle still folds (global failures deserve a bubble)', () => {
    expect(
      classifyEvent(
        { type: 'error', message: 'Add a provider first.' },
        ctx({ streaming: false, activeTurnId: null }),
      ),
    ).toBe('fold');
  });

  it('an attributed error folds for the matching turn and drops for a foreign one', () => {
    expect(classifyEvent({ type: 'error', message: 'boom', turnId: 't1' }, ctx())).toBe('fold');
    expect(classifyEvent({ type: 'error', message: 'boom', turnId: 't2' }, ctx())).toBe('drop');
  });

  it('drops an edit-recorded stamped for another tab; folds same-tab and unstamped ones', () => {
    expect(classifyEvent({ type: 'edit-recorded', edit, tabId: 2 }, ctx())).toBe('drop');
    expect(classifyEvent({ type: 'edit-recorded', edit, tabId: 1 }, ctx())).toBe('fold');
    expect(classifyEvent({ type: 'edit-recorded', edit }, ctx())).toBe('fold');
    // An unkeyed view (no thread-get applied yet) folds rather than going dark.
    expect(classifyEvent({ type: 'edit-recorded', edit, tabId: 2 }, ctx({ viewTabId: null }))).toBe(
      'fold',
    );
  });

  it('non-turn stream messages always fold', () => {
    expect(classifyEvent({ type: 'picker-state', active: true }, ctx())).toBe('fold');
    expect(classifyEvent({ type: 'session-state', state: 'running' }, ctx())).toBe('fold');
  });
});

describe('threadToMessages: thread-get rebuild mapping (#168)', () => {
  it('maps roles, text, and settled tool chips; everything arrives closed', () => {
    const rebuilt = threadToMessages([
      { role: 'user', text: 'make it pop' },
      {
        role: 'assistant',
        text: 'done',
        tools: [
          { name: 'query', ok: true },
          { name: 'setStyle', ok: false },
        ],
      },
    ]);
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[0]).toMatchObject({ role: 'user', text: 'make it pop', streaming: false });
    expect(rebuilt[1]).toMatchObject({ role: 'assistant', text: 'done', streaming: false });
    expect(rebuilt[1]?.toolCalls).toEqual([
      { tool: 'query', ok: true },
      { tool: 'setStyle', ok: false },
    ]);
    // Distinct ids so keyed rendering never collides.
    expect(rebuilt[0]?.id).not.toBe(rebuilt[1]?.id);
  });

  it('an empty thread maps to an empty chat', () => {
    expect(threadToMessages([])).toEqual([]);
  });

  it('maps a rehydrated turn to AT MOST two segments — the view carries no interleaving info', () => {
    const rebuilt = threadToMessages([
      { role: 'user', text: 'make it pop' },
      { role: 'assistant', text: 'done', tools: [{ name: 'setStyle', ok: true }] },
      { role: 'assistant', text: 'just words' },
      { role: 'assistant', text: '', tools: [{ name: 'query', ok: true }] },
    ]);
    expect(rebuilt[0]?.segments).toEqual([{ kind: 'text', text: 'make it pop' }]);
    expect(rebuilt[1]?.segments).toEqual([
      { kind: 'text', text: 'done' },
      { kind: 'tools', calls: [{ tool: 'setStyle', ok: true }] },
    ]);
    expect(rebuilt[2]?.segments).toEqual([{ kind: 'text', text: 'just words' }]);
    expect(rebuilt[3]?.segments).toEqual([{ kind: 'tools', calls: [{ tool: 'query', ok: true }] }]);
  });
});

describe('keepsLocalTurn: which view survives a thread-get rebuild', () => {
  it('protects a streaming turn the SW confirms is running', () => {
    expect(
      keepsLocalTurn(
        { streaming: true, activeTurnId: 't1' },
        { turnRunning: true, currentTurnId: 't1' },
      ),
    ).toBe(true);
  });

  it('yields when the SW is on a DIFFERENT turn — the local bubble is provably stale', () => {
    expect(
      keepsLocalTurn(
        { streaming: true, activeTurnId: 't1' },
        { turnRunning: true, currentTurnId: 't9' },
      ),
    ).toBe(false);
  });

  it('never protects an idle panel — with nothing in flight the rebuild wins', () => {
    expect(
      keepsLocalTurn(
        { streaming: false, activeTurnId: null },
        { turnRunning: false, currentTurnId: undefined },
      ),
    ).toBe(false);
    expect(
      keepsLocalTurn(
        { streaming: false, activeTurnId: 't1' },
        { turnRunning: true, currentTurnId: 't1' },
      ),
    ).toBe(false);
  });

  it('protects when the SW names no turn — turnRunning:false alone is not proof of death', () => {
    // The reconnect race (#168 finding 2): a fresh worker answers before the turn re-registers.
    // The liveness check owns closing the bubble; the rebuild must not delete its text.
    expect(keepsLocalTurn({ streaming: true, activeTurnId: 't1' }, { turnRunning: false })).toBe(
      true,
    );
    expect(keepsLocalTurn({ streaming: true, activeTurnId: null }, { turnRunning: true })).toBe(
      true,
    );
  });
});

describe('mergeInFlight: persisted history + the live local tail', () => {
  const persisted = threadToMessages([
    { role: 'user', text: 'go' },
    { role: 'assistant', text: 'earlier reply' },
  ]);

  it('keeps the in-flight tail on top of the persisted history', () => {
    const local: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        segments: [{ kind: 'text', text: 'go' }],
        text: 'go',
        toolCalls: [],
        edits: [],
        streaming: false,
      },
      {
        id: 'a1',
        role: 'assistant',
        segments: [{ kind: 'text', text: 'streamed' }],
        text: 'streamed',
        toolCalls: [],
        edits: [],
        streaming: true,
      },
    ];
    const merged = mergeInFlight(persisted, local);
    expect(merged).toHaveLength(3);
    expect(merged.slice(0, 2)).toEqual(persisted);
    expect(merged[2]).toMatchObject({ role: 'assistant', text: 'streamed', streaming: true });
  });

  it('lets the rebuild win when nothing is in flight', () => {
    const local: ChatMessage[] = [
      {
        id: 'a0',
        role: 'assistant',
        segments: [{ kind: 'text', text: 'old view' }],
        text: 'old view',
        toolCalls: [],
        edits: [],
        streaming: false,
      },
    ];
    expect(mergeInFlight(persisted, local)).toEqual(persisted);
  });

  it('drops the local user bubble in favour of the persisted copy — never duplicated', () => {
    // The SW appends the user message before the turn runs, so the persisted thread already
    // carries it; keeping the local one too would show "go" twice.
    const local: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        segments: [{ kind: 'text', text: 'go' }],
        text: 'go',
        toolCalls: [],
        edits: [],
        streaming: false,
      },
      {
        id: 'a1',
        role: 'assistant',
        segments: [{ kind: 'text', text: 'streamed' }],
        text: 'streamed',
        toolCalls: [],
        edits: [],
        streaming: true,
      },
    ];
    const merged = mergeInFlight(threadToMessages([{ role: 'user', text: 'go' }]), local);
    expect(merged.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(merged.map((m) => [m.role, m.text])).toEqual([
      ['user', 'go'],
      ['assistant', 'streamed'],
    ]);
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

/** Default RPC handler: user-message acks ok with a turnId; session/thread hydration RPCs reply a
 *  malformed shape on purpose so `hydrateThread` no-ops (its failure path leaves the stream-built
 *  view untouched) and the stream tests stay deterministic. Override per test. */
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

// What the picker resolves and the composer's context chip displays — the referent of "this".
const pickedSelector: StableSelector = {
  value: '[data-testid="cta"]',
  strategy: 'data-attr',
  fragile: false,
};
const otherSelector: StableSelector = { value: '#hero', strategy: 'id', fragile: false };

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('chat store actions: ack-gated send (#168 D)', () => {
  it('does NOT append the user message until the SW ack says ok', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(ackHandler());
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    const pending = store.send('make the hero pink');
    // Optimistic composer lock, honest transcript: streaming flips immediately, the bubble waits
    // for the ack.
    expect(store.messages()).toHaveLength(0);
    expect(store.streaming()).toBe(true);

    await pending;
    expect(store.messages()).toHaveLength(1);
    expect(store.messages()[0]).toMatchObject({ role: 'user', text: 'make the hero pink' });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user-message', text: 'make the hero pink' }),
    );
  });

  it('a rejected send surfaces a composer-level notice, never a phantom bubble', async () => {
    vi.resetModules();
    installChromeFake(ackHandler({ 'user-message': () => ({ ok: false, error: 'busy' }) }));
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    await store.send('hi');

    expect(store.messages()).toEqual([]);
    expect(store.error()).toBe('busy');
    expect(store.streaming()).toBe(false);
  });

  it('drops a send fired while a turn already streams (chip double-fire guard, #168 finding 5)', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(ackHandler());
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    const first = store.send('copy the hero'); // streaming flips true synchronously…
    await store.send('copy the hero'); // …so the double-fired chip send is dropped outright
    await first;

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(store.messages()).toHaveLength(1);
  });

  it('send() carries the picked element so "this" has a referent', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(ackHandler());
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    await store.send('make this 20% bigger', undefined, pickedSelector);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user-message', selector: pickedSelector }),
    );
  });

  it('send() carries the shift-multi-select set from the focus store', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(ackHandler());
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
    const { sendMessage } = installChromeFake(ackHandler());
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    await store.send('make the hero pink');

    const sent = sendMessage.mock.calls[0]?.[0] as PanelToSw & { selectors?: unknown };
    expect(sent.selectors).toBeUndefined();
  });

  it('send() ignores a blank/whitespace-only draft', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(ackHandler());
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    await store.send('   ');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.messages()).toEqual([]);
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
    const { sendMessage } = installChromeFake(ackHandler());
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    await store.stopTurn();

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'session-stop' }));
  });
});

describe('chat store stream: turn attribution (#168 A/E)', () => {
  it('an unattributed error mid-turn does NOT end streaming or close the bubble', async () => {
    // Finding 1, failure case first: pre-fix, ANY error push flipped streaming false and closed
    // the live bubble — a ship failure killed a running turn's UI.
    vi.resetModules();
    installChromeFake(ackHandler());
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('go');
    port.emit({ type: 'token', text: 'partial', turnId: 't1' });

    port.emit({ type: 'error', message: 'history append failed' });

    expect(store.streaming()).toBe(true);
    expect(store.messages().at(-1)).toMatchObject({ text: 'partial', streaming: true });
    expect(store.messages().at(-1)?.error).toBeUndefined();
    expect(store.error()).toBe('history append failed'); // surfaced as the composer-level notice
  });

  it('an error attributed to the active turn ends it; the trailing turn-done still folds usage', async () => {
    vi.resetModules();
    installChromeFake(ackHandler());
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('go');
    port.emit({ type: 'token', text: 'partial', turnId: 't1' });
    port.emit({ type: 'error', message: 'boom', turnId: 't1' });

    expect(store.streaming()).toBe(false);
    expect(store.messages().at(-1)).toMatchObject({ error: 'boom', streaming: false });

    port.emit({ type: 'turn-done', usage: { steps: 2, tokens: 900 }, turnId: 't1' });
    expect(store.usage()).toEqual({ steps: 2, tokens: 900 });
  });

  it("a foreign turn's token/turn-done never mutate this panel's transcript or usage", async () => {
    vi.resetModules();
    installChromeFake(ackHandler());
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('go');
    port.emit({ type: 'token', text: 'mine', turnId: 't1' });

    port.emit({ type: 'token', text: ' THEIRS', turnId: 't2' });
    port.emit({ type: 'turn-done', usage: { steps: 9, tokens: 9999 }, turnId: 't2' });

    expect(store.messages().at(-1)).toMatchObject({ text: 'mine', streaming: true });
    expect(store.streaming()).toBe(true);
    expect(store.usage()).toEqual(store.ZERO_USAGE);

    port.emit({ type: 'turn-done', usage: { steps: 2, tokens: 900 }, turnId: 't1' });
    expect(store.streaming()).toBe(false);
    expect(store.usage()).toEqual({ steps: 2, tokens: 900 });
  });

  it('unstamped events keep folding for a pre-#168 SW (ack without turnId)', async () => {
    vi.resetModules();
    installChromeFake(ackHandler({ 'user-message': () => ({ ok: true }) }));
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('hi');
    port.emit({ type: 'token', text: 'working on it' });
    expect(store.messages().at(-1)?.text).toBe('working on it');

    port.emit(turnDone(2, 900));
    expect(store.streaming()).toBe(false);
    expect(store.usage()).toEqual({ steps: 2, tokens: 900 });
  });

  it("holds a turn's stamped events that beat the ack and replays them once keyed", async () => {
    vi.resetModules();
    let resolveAck: (() => void) | undefined;
    installChromeFake(
      ackHandler({
        'user-message': () =>
          new Promise((resolve) => {
            resolveAck = () => resolve({ ok: true, turnId: 't1' });
          }),
      }),
    );
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    const pending = store.send('go');
    await Promise.resolve(); // let the request reach the fake so the ack is pending
    port.emit({ type: 'token', text: 'early', turnId: 't1' }); // beats the ack

    resolveAck?.();
    await pending;

    expect(store.messages().map((m) => [m.role, m.text])).toEqual([
      ['user', 'go'],
      ['assistant', 'early'],
    ]);
  });
});

describe('chat store: reconnect-race liveness check (#168 B)', () => {
  const sessionAlive = {
    ok: true,
    state: 'running',
    turnRunning: true,
    tabId: 1,
    currentTurnId: 't1',
  };
  const sessionDead = { ok: true, state: 'running', turnRunning: false, tabId: 1 };

  async function bootMidTurn(sessionReply: () => unknown) {
    vi.resetModules();
    vi.useFakeTimers();
    installChromeFake(ackHandler({ 'session-get': sessionReply }));
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');
    store.initChatStore();
    await store.send('go');
    port.emit({ type: 'token', text: 'working', turnId: 't1' });
    return { store, port };
  }

  it('a turnRunning:false push does not kill the live stream immediately', async () => {
    const { store, port } = await bootMidTurn(() => sessionDead);

    port.emit({ type: 'session-state', state: 'running', turnRunning: false });

    expect(store.streaming()).toBe(true); // pre-fix this was already false
    expect(store.messages().at(-1)?.streaming).toBe(true);
  });

  it('closes the turn only after the delayed session-get confirms it dead', async () => {
    const { store, port } = await bootMidTurn(() => sessionDead);

    port.emit({ type: 'session-state', state: 'running', turnRunning: false });
    await vi.advanceTimersByTimeAsync(store.TURN_LIVENESS_DELAY_MS + 1);

    expect(store.streaming()).toBe(false);
    expect(store.messages().at(-1)?.streaming).toBe(false);
  });

  it('keeps streaming when the confirmation says the turn is alive after all', async () => {
    const { store, port } = await bootMidTurn(() => sessionAlive);

    port.emit({ type: 'session-state', state: 'running', turnRunning: false });
    await vi.advanceTimersByTimeAsync(store.TURN_LIVENESS_DELAY_MS + 1);

    expect(store.streaming()).toBe(true);
    expect(store.messages().at(-1)?.streaming).toBe(true);
  });

  it('a non-running session-state still ends the turn immediately (Stop path)', async () => {
    const { store, port } = await bootMidTurn(() => sessionAlive);

    port.emit({ type: 'session-state', state: 'stopped' });

    expect(store.streaming()).toBe(false);
    expect(store.messages().at(-1)?.streaming).toBe(false);
  });
});

describe('chat store: thread-get rebuild + adoption (#168 C/E)', () => {
  const thread = [
    { role: 'user', text: 'make it pop' },
    { role: 'assistant', text: 'done', tools: [{ name: 'setStyle', ok: true }] },
  ];

  it('rebuilds the transcript from the SW thread and keys the view to its tab', async () => {
    vi.resetModules();
    installChromeFake(
      ackHandler({
        'session-get': () => ({ ok: true, state: 'running', turnRunning: false, tabId: 2 }),
        'thread-get': () => ({ ok: true, tabId: 2, thread }),
      }),
    );
    installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.hydrateThread();

    expect(store.messages().map((m) => [m.role, m.text, m.streaming])).toEqual([
      ['user', 'make it pop', false],
      ['assistant', 'done', false],
    ]);
    expect(store.messages()[1]?.toolCalls).toEqual([{ tool: 'setStyle', ok: true }]);
    expect(store.viewTabId()).toBe(2);
    expect(store.streaming()).toBe(false);
  });

  it('adopts the in-flight turn on rebuild so a reopened panel re-attaches to it', async () => {
    vi.resetModules();
    installChromeFake(
      ackHandler({
        'session-get': () => ({
          ok: true,
          state: 'running',
          turnRunning: true,
          tabId: 2,
          currentTurnId: 't9',
        }),
        'thread-get': () => ({ ok: true, tabId: 2, thread }),
      }),
    );
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.hydrateThread();

    expect(store.streaming()).toBe(true);
    expect(store.activeTurnId()).toBe('t9');

    port.emit({ type: 'token', text: 'still going', turnId: 't9' }); // re-attached
    expect(store.messages().at(-1)).toMatchObject({ text: 'still going', streaming: true });

    port.emit({ type: 'token', text: 'NOPE', turnId: 'tz' }); // a foreign turn stays foreign
    expect(store.messages().at(-1)?.text).toBe('still going');
  });

  it("an empty/errored thread for the tab shows an empty chat, not another tab's transcript", async () => {
    vi.resetModules();
    installChromeFake(
      ackHandler({
        'session-get': () => ({ ok: true, state: 'idle', turnRunning: false, tabId: 3 }),
        'thread-get': () => ({ ok: false, tabId: 3, error: 'no session' }),
      }),
    );
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    // Seed a fake prior view, as if the panel had been showing another tab. The seeded turn is
    // SETTLED before the retarget: a still-streaming local turn is a different case, protected by
    // the hydrate guard (see "a rebuild never clobbers the live local turn" below).
    await store.send('old tab message');
    port.emit({ type: 'turn-done', usage: { steps: 1, tokens: 10 }, turnId: 't1' });
    expect(store.messages()).toHaveLength(1);
    expect(store.streaming()).toBe(false);

    await store.hydrateThread();

    expect(store.messages()).toEqual([]);
    expect(store.viewTabId()).toBe(3);
    expect(store.streaming()).toBe(false);
  });

  it('a failed hydrate leaves the stream-built view untouched', async () => {
    vi.resetModules();
    installChromeFake(
      ackHandler({
        'thread-get': () => {
          throw new Error('no handler');
        },
      }),
    );
    installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('hi');

    await store.hydrateThread();

    expect(store.messages()).toHaveLength(1);
    expect(store.messages()[0]).toMatchObject({ role: 'user', text: 'hi' });
  });

  it('re-keying to a different tab resets the usage meter (per-tab spend)', async () => {
    vi.resetModules();
    installChromeFake(
      ackHandler({
        'session-get': () => ({ ok: true, state: 'running', turnRunning: false, tabId: 5 }),
        'thread-get': () => ({ ok: true, tabId: 5, thread: [] }),
      }),
    );
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('hi');
    port.emit({ type: 'turn-done', usage: { steps: 3, tokens: 1200 }, turnId: 't1' });
    expect(store.usage()).toEqual({ steps: 3, tokens: 1200 });

    await store.hydrateThread(); // view was unkeyed (null) -> tab 5 counts as a re-key

    expect(store.usage()).toEqual(store.ZERO_USAGE);
  });
});

describe('chat store: a rebuild never clobbers the live local turn (P0 hydrate guard)', () => {
  // The bug: `thread-get` renders the SW's PERSISTED thread, and the SW appends a turn's assistant
  // messages only once the whole turn resolves — so every retarget trigger (port reconnect,
  // tabs.onActivated, windows.onFocusChanged, the agent's OWN tab activations) that landed mid-turn
  // rebuilt the transcript WITHOUT the text this panel had just streamed: appear → disappear →
  // reappear, sometimes blanking the panel to EmptyState and orphaning the turn.

  const idleSession = { ok: true, state: 'idle', turnRunning: false, tabId: 1 };
  const midTurnSession = {
    ok: true,
    state: 'running',
    turnRunning: true,
    tabId: 1,
    currentTurnId: 't1',
  };
  // What the SW has PERSISTED mid-turn: the user message only — the streamed reply is not there.
  const midTurnThread = [{ role: 'user', text: 'go' }];

  /** Chrome fake whose hydration replies can be swapped mid-test, so the store can be keyed to
   *  tab 1 first (an applied initial hydrate) and then hit with a mid-turn rebuild. */
  function installSwappableFake() {
    let handler: SendMessage = ackHandler({
      'session-get': () => idleSession,
      'thread-get': () => ({ ok: true, tabId: 1, thread: [] }),
    });
    const { sendMessage } = installChromeFake((msg) => handler(msg));
    return {
      sendMessage,
      swap: (over: Parameters<typeof ackHandler>[0]) => {
        handler = ackHandler(over);
      },
    };
  }

  async function bootStreamingOnTab1() {
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');
    store.initChatStore();
    await store.hydrateThread(); // keys the view to tab 1 while idle
    expect(store.viewTabId()).toBe(1);
    await store.send('go');
    port.emit({ type: 'token', text: 'streamed reply', turnId: 't1' });
    expect(store.messages().at(-1)).toMatchObject({ text: 'streamed reply', streaming: true });
    return { store, port };
  }

  it('keeps the streamed reply when a retarget rebuild lands mid-turn', async () => {
    vi.resetModules();
    const fake = installSwappableFake();
    const { store, port } = await bootStreamingOnTab1();

    fake.swap({
      'session-get': () => midTurnSession,
      'thread-get': () => ({ ok: true, tabId: 1, thread: midTurnThread }),
    });
    await store.hydrateThread(); // tabs.onActivated / reconnect retarget, mid-turn

    // Pre-guard this was `[user 'go']` — the streamed text vanished under the reader.
    expect(store.messages().map((m) => [m.role, m.text])).toEqual([
      ['user', 'go'],
      ['assistant', 'streamed reply'],
    ]);
    expect(store.streaming()).toBe(true);
    expect(store.activeTurnId()).toBe('t1');

    // The next token folds onto the SAME bubble — exactly one streaming assistant message.
    port.emit({ type: 'token', text: ' continues', turnId: 't1' });
    const streamingAssistants = store
      .messages()
      .filter((m) => m.role === 'assistant' && m.streaming);
    expect(streamingAssistants).toHaveLength(1);
    expect(streamingAssistants[0]?.text).toBe('streamed reply continues');
  });

  it('leaves transcript, turn key and Stop state alone on a thread-get ok:false mid-turn', async () => {
    vi.resetModules();
    const fake = installSwappableFake();
    const { store, port } = await bootStreamingOnTab1();

    fake.swap({
      'session-get': () => midTurnSession,
      'thread-get': () => ({ ok: false, tabId: 4, error: 'no session' }),
    });
    await store.hydrateThread();

    // Pre-guard this branch blanked the panel to EmptyState (`setMessages([])`), dropped the turn
    // key (orphaning the rest of the turn's stamped events) and turned Stop back into Send.
    expect(store.messages().map((m) => [m.role, m.text])).toEqual([
      ['user', 'go'],
      ['assistant', 'streamed reply'],
    ]);
    expect(store.streaming()).toBe(true);
    expect(store.activeTurnId()).toBe('t1');

    port.emit({ type: 'token', text: ' still folds', turnId: 't1' });
    expect(store.messages().at(-1)?.text).toBe('streamed reply still folds');
  });

  it('re-targets once the turn settles: a skipped hydrate is re-fired on turn-done', async () => {
    vi.resetModules();
    const fake = installSwappableFake();
    const { store, port } = await bootStreamingOnTab1();

    let threadGets = 0;
    fake.swap({
      'session-get': () => midTurnSession,
      'thread-get': () => {
        threadGets++;
        return { ok: false, tabId: 4, error: 'no session' };
      },
    });
    await store.hydrateThread(); // skipped: nothing to merge for a foreign tab
    expect(threadGets).toBe(1);

    port.emit({ type: 'turn-done', usage: { steps: 1, tokens: 100 }, turnId: 't1' });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the re-fired hydrate run

    expect(threadGets).toBe(2); // the panel still ends up on the tab the user is looking at
  });

  it('pins the thread-get query to the turn tab mid-turn, and unpins it once idle', async () => {
    // Additive `tabId` on the RPC, sent ONLY while a turn is in flight: mid-turn the transcript
    // belongs to the turn's tab, and the SW honours an explicit ask that has a session — so a tab
    // switch cannot re-target the query away from the conversation being streamed. Once the turn
    // settles the ask must go out UNPINNED: the SW's own resolution is what implements "the chat
    // follows the tab you're looking at", and a standing pin would freeze the panel on its first
    // conversation forever.
    vi.resetModules();
    const fake = installSwappableFake();
    const { store, port } = await bootStreamingOnTab1();

    let asked: Extract<PanelToSw, { type: 'thread-get' }> | undefined;
    fake.swap({
      'session-get': () => midTurnSession,
      'thread-get': (msg) => {
        asked = msg as Extract<PanelToSw, { type: 'thread-get' }>;
        return { ok: true, tabId: 1, thread: midTurnThread };
      },
    });
    await store.hydrateThread(); // mid-turn: pinned to the keyed tab
    expect(asked).toMatchObject({ type: 'thread-get', tabId: 1 });

    port.emit({ type: 'turn-done', usage: { steps: 1, tokens: 100 }, turnId: 't1' });
    expect(store.streaming()).toBe(false);
    fake.swap({
      'session-get': () => idleSession,
      'thread-get': (msg) => {
        asked = msg as Extract<PanelToSw, { type: 'thread-get' }>;
        return { ok: true, tabId: 1, thread: midTurnThread };
      },
    });
    await store.hydrateThread(); // idle: unpinned, so following stays alive
    expect(asked?.type).toBe('thread-get');
    expect(asked?.tabId).toBeUndefined();
  });

  it('still rebuilds when the SW has moved on to another turn', async () => {
    vi.resetModules();
    const fake = installSwappableFake();
    const { store } = await bootStreamingOnTab1();

    fake.swap({
      'session-get': () => ({
        ok: true,
        state: 'running',
        turnRunning: true,
        tabId: 1,
        currentTurnId: 't9',
      }),
      'thread-get': () => ({
        ok: true,
        tabId: 1,
        thread: [
          { role: 'user', text: 'go' },
          { role: 'assistant', text: 'done elsewhere' },
        ],
      }),
    });
    await store.hydrateThread();

    // The one case the local bubble is provably stale: wholesale replace, adopt the SW's turn.
    expect(store.messages().map((m) => [m.role, m.text, m.streaming])).toEqual([
      ['user', 'go', false],
      ['assistant', 'done elsewhere', false],
    ]);
    expect(store.activeTurnId()).toBe('t9');
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
