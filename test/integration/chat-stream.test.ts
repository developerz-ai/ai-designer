import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolCallOutcome } from '@/entrypoints/sidepanel/components/chat/ToolCallList';
import type { ChatMessage } from '@/entrypoints/sidepanel/stores/chat';
import type { PanelToSw, SwToPanel } from '@/shared/messages';

// Integration: a mocked `SwToPanel` stream, the way background.ts's real `runTurn` forwarding
// emits it, folded through the real chat store (`stores/chat.ts`) end to end — proving the two
// hops Thread/Message/ToolChip actually render from compose: streamed text accumulates into a
// bubble, a tool-call becomes a chip-shaped entry, and that chip's status reflects its OWN
// reported outcome (pending until a tool-result says otherwise).
//
// #168 turn attribution semantics pinned here (the store was rewritten):
//   • the user bubble is ACK-GATED — it lands only when `UserMessageResult.ok` comes back, and the
//     ack's `turnId` keys the panel to the turn;
//   • stream events stamped with ANOTHER turn's id are dropped; unstamped events still fold
//     (pre-#168 SW back-compat);
//   • an UNATTRIBUTED `error` during a live turn is a composer-level notice — it must NOT end the
//     stream (pre-fix, a history-append failure pushed mid-turn killed the live bubble); only the
//     turn's own terminal events (`turn-done` / an error stamped with its id) close it;
//   • `send()` while streaming is DROPPED outright (the chip double-fire guard; a duplicate send
//     would abort the real turn SW-side).

const TURN_ID = 'turn-A';

/** SW stand-in: ack `user-message` with a turnId (#168), reply `{ok:true}` to everything else —
 *  which fails the hydrate RPCs' schema parse, keeping `hydrateThread` inert so these tests
 *  exercise the STREAM fold alone (hydration has its own coverage in panel-reconnect.test.ts). */
function installChromeFake(
  userMessageReply: () => unknown = () => ({ ok: true, turnId: TURN_ID }),
): { sent: () => PanelToSw[] } {
  const sent: PanelToSw[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: vi.fn(async (msg: PanelToSw) => {
        sent.push(msg);
        return msg.type === 'user-message' ? userMessageReply() : { ok: true };
      }),
    },
  };
  return { sent: () => sent };
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

/** The outcome ToolCallList derives for each chip — from the call's OWN result, never from
 *  its index. A `tool-call` on the bus means the model REQUESTED the tool (loop.ts emits on
 *  the SDK's tool-call stream part, before execution), so a call with no result yet is
 *  pending/running, never done. Earlier versions of this file asserted the opposite and so
 *  encoded the bug: a failed edit rendered as a green tick. */
function chipStatusesFor(m: ChatMessage): string[] {
  return m.toolCalls.map((tc) => toolCallOutcome(tc, m.streaming));
}

/** The turn's assistant bubble — the last entry in the thread. */
function bubbleOf(messages: ChatMessage[]): ChatMessage {
  const last = messages.at(-1);
  if (!last) throw new Error('no assistant bubble');
  return last;
}

async function freshStore() {
  vi.resetModules();
  const chromeFake = installChromeFake();
  const port = installPortFake();
  const store = await import('@/entrypoints/sidepanel/stores/chat');
  store.initChatStore();
  return { store, port, chromeFake };
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('mocked SwToPanel stream -> chat store -> Thread/ToolChip render shape', () => {
  it('accumulates streamed text and renders a running -> done tool chip across one turn', async () => {
    const { store, port } = await freshStore();
    await store.send('recolor the hero CTA');

    // #168: the ack keyed the panel to TURN_ID; the SW stamps every event with it.
    port.emit({ type: 'token', text: 'On it', turnId: TURN_ID });
    port.emit({ type: 'token', text: ' — ', turnId: TURN_ID });
    port.emit({
      type: 'tool-call',
      tool: 'setStyle',
      selector: '#cta',
      kind: 'act',
      turnId: TURN_ID,
    });

    // Mid-turn: the bubble is still streaming, so Thread would render its one tool call as a
    // running ToolChip — Cursor-style "still working" feedback, not a dead 'done' default.
    let bubble = store.messages().at(-1);
    expect(bubble).toBeDefined();
    if (!bubble) throw new Error('unreachable');
    expect(bubble.streaming).toBe(true);
    expect(bubble.toolCalls).toEqual([{ tool: 'setStyle', selector: '#cta', kind: 'act' }]);
    expect(chipStatusesFor(bubble)).toEqual(['running']);

    port.emit({ type: 'token', text: 'recolored it.', turnId: TURN_ID });
    port.emit({ type: 'turn-done', usage: { steps: 0, tokens: 0 }, turnId: TURN_ID });

    // Turn closed out: same chip, now done — text fully accumulated for Thread to display.
    bubble = store.messages().at(-1);
    if (!bubble) throw new Error('unreachable');
    expect(bubble.streaming).toBe(false);
    expect(bubble.text).toBe('On it — recolored it.');
    // Turn closed, but nothing ever reported whether `setStyle` succeeded, so the chip
    // stays pending rather than claiming success. It becomes 'done' only once a
    // `tool-result` arrives and the store records `ok` on the entry.
    expect(chipStatusesFor(bubble)).toEqual(['pending']);
    // The ack-gated user bubble landed exactly once, ahead of the assistant's.
    expect(store.messages().filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('a tool-result settles its chip: done on ok, failed with the reason on not-ok', async () => {
    const { store, port } = await freshStore();
    await store.send('recolor the hero CTA');

    // loop.ts forwards the SDK's tool-call/tool-result parts correlated by `toolCallId`.
    port.emit({
      type: 'tool-call',
      tool: 'setStyle',
      selector: '#gone',
      kind: 'act',
      id: 'c1',
      turnId: TURN_ID,
    });
    port.emit({
      type: 'tool-call',
      tool: 'setStyle',
      selector: '#cta',
      kind: 'act',
      id: 'c2',
      turnId: TURN_ID,
    });
    expect(chipStatusesFor(bubbleOf(store.messages()))).toEqual(['running', 'running']);

    port.emit({
      type: 'tool-result',
      tool: 'setStyle',
      ok: false,
      id: 'c1',
      error: 'no element matches #gone',
      turnId: TURN_ID,
    });
    port.emit({ type: 'tool-result', tool: 'setStyle', ok: true, id: 'c2', turnId: TURN_ID });
    port.emit({ type: 'turn-done', usage: { steps: 2, tokens: 40 }, turnId: TURN_ID });

    const bubble = bubbleOf(store.messages());
    expect(chipStatusesFor(bubble)).toEqual(['failed', 'done']);
    // The failed chip says why — the one thing that makes a red chip actionable.
    expect(bubble.toolCalls[0]?.error).toBe('no element matches #gone');
  });

  it('Stop closes the bubble and stills its chips — no turn-done ever arrives', async () => {
    const { store, port } = await freshStore();
    await store.send('restyle everything');
    port.emit({ type: 'tool-call', tool: 'setStyle', selector: '#cta', kind: 'act', id: 'c1' });

    // background.ts's `session-stop` clears `turnAbort` itself, so the aborted turn's own
    // `turn-done` never fires: the non-running session-state is the only settle signal.
    port.emit({ type: 'session-state', state: 'stopped' });

    const bubble = bubbleOf(store.messages());
    expect(store.streaming()).toBe(false);
    expect(bubble.streaming).toBe(false);
    // Still unsettled — but no longer claiming the agent is mid-edit.
    expect(chipStatusesFor(bubble)).toEqual(['pending']);
  });

  it('an UNATTRIBUTED mid-turn error is a notice — the live bubble keeps streaming (#168)', async () => {
    const { store, port } = await freshStore();
    await store.send('debug the layout');

    port.emit({ type: 'token', text: 'Looking', turnId: TURN_ID });
    port.emit({ type: 'tool-call', tool: 'diagnostics', kind: 'read', turnId: TURN_ID });
    // The SW pushes persistence trouble (history append, thread save) with NO turnId. Pre-#168
    // the store read ANY error as "turn over" and killed the live bubble (finding 5).
    port.emit({ type: 'error', message: 'history append failed' });

    let bubble = store.messages().at(-1);
    if (!bubble) throw new Error('unreachable');
    expect(bubble.streaming).toBe(true); // the turn is still alive
    expect(bubble.error).toBeUndefined();
    expect(store.error()).toBe('history append failed'); // surfaced as a composer-level notice

    // The turn's OWN error — stamped with its id — is the terminal one.
    port.emit({ type: 'error', message: 'provider unreachable', turnId: TURN_ID });
    bubble = store.messages().at(-1);
    if (!bubble) throw new Error('unreachable');
    expect(bubble.streaming).toBe(false);
    expect(bubble.error).toBe('provider unreachable');
    // The turn errored, but that does not prove THIS tool was the thing that failed —
    // attributing the turn error to the last chip is exactly the fabrication we removed.
    expect(chipStatusesFor(bubble)).toEqual(['pending']);
  });

  it("drops another turn's stamped events — a second window's stream can't bleed in (#168)", async () => {
    const { store, port } = await freshStore();
    await store.send('recolor the hero CTA');

    port.emit({ type: 'token', text: 'mine', turnId: TURN_ID });
    port.emit({ type: 'token', text: ' NOT MINE', turnId: 'turn-B' });
    port.emit({ type: 'tool-call', tool: 'setStyle', kind: 'act', turnId: 'turn-B' });

    const bubble = bubbleOf(store.messages());
    expect(bubble.text).toBe('mine');
    expect(bubble.toolCalls).toEqual([]);
  });

  it('multiple tool calls in one turn: only the newest tracks the bubble, earlier ones stay done', async () => {
    const { store, port } = await freshStore();
    await store.send('copy the reference hero');

    // Unstamped events — a pre-#168 SW. They must keep folding (back-compat), keyed or not.
    port.emit({ type: 'tool-call', tool: 'browse', kind: 'read' });
    port.emit({ type: 'tool-call', tool: 'extractIdentity', kind: 'read' });
    port.emit({ type: 'tool-call', tool: 'setStyle', selector: '#hero', kind: 'act' });

    let bubble = store.messages().at(-1);
    if (!bubble) throw new Error('unreachable');
    expect(bubble.toolCalls.map((tc) => tc.tool)).toEqual([
      'browse',
      'extractIdentity',
      'setStyle',
    ]);
    // All three were requested; none has reported back. The newest tracks the live turn.
    expect(chipStatusesFor(bubble)).toEqual(['running', 'running', 'running']);

    port.emit({ type: 'turn-done', usage: { steps: 0, tokens: 0 } });
    bubble = store.messages().at(-1);
    if (!bubble) throw new Error('unreachable');
    expect(chipStatusesFor(bubble)).toEqual(['pending', 'pending', 'pending']);
  });
});

describe('send() gating (#168)', () => {
  it('drops a send while a turn is streaming — one RPC, one user bubble', async () => {
    const { store, chromeFake } = await freshStore();
    await store.send('recolor the hero CTA'); // streaming() is now true (ack ok)

    await store.send('recolor it again'); // composer double-fire / suggestion chip path

    const userMessages = chromeFake.sent().filter((m) => m.type === 'user-message');
    expect(userMessages).toHaveLength(1); // the duplicate never reached the SW (it would abort the real turn)
    expect(store.messages().filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('a rejected ack appends NO user bubble and surfaces the reason as a notice', async () => {
    vi.resetModules();
    installChromeFake(() => ({ ok: false, error: 'Open a web page to start designing.' }));
    installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');
    store.initChatStore();

    await store.send('recolor the hero CTA');

    expect(store.messages()).toEqual([]); // no phantom bubble for a message the SW refused
    expect(store.streaming()).toBe(false); // composer re-enabled
    expect(store.error()).toBe('Open a web page to start designing.');
  });
});
