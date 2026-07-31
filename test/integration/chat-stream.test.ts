import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolCallOutcome } from '@/entrypoints/sidepanel/components/chat/ToolCallList';
import type { ChatMessage } from '@/entrypoints/sidepanel/stores/chat';
import type { PanelToSw, SwToPanel } from '@/shared/messages';

// Integration: a mocked `SwToPanel` stream, the way background.ts's real `runTurn` forwarding
// emits it, folded through the real chat store (`stores/chat.ts`) end to end — proving the two
// hops Thread/Message/ToolChip actually render from compose the way task #70 asks: streamed
// text accumulates into a bubble, a tool-call becomes a chip-shaped entry, and that chip's
// status reflects its OWN reported outcome (pending until a tool-result says otherwise). Each hop already has its own unit
// coverage (chat-panel-store.test.ts's reduceChat cases, tool-chip.test.ts, message.test.ts);
// this is the composition, mirroring picker-focus.test.ts's "prove they wire the way
// background.ts/content.ts actually wire them" approach.

function installChromeFake(): void {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage: vi.fn(async (_msg: PanelToSw) => ({ ok: true })) },
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

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('mocked SwToPanel stream -> chat store -> Thread/ToolChip render shape', () => {
  it('accumulates streamed text and renders a running -> done tool chip across one turn', async () => {
    vi.resetModules();
    installChromeFake();
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('recolor the hero CTA');

    port.emit({ type: 'token', text: 'On it' });
    port.emit({ type: 'token', text: ' — ' });
    port.emit({
      type: 'tool-call',
      tool: 'setStyle',
      selector: '#cta',
      kind: 'act',
    });

    // Mid-turn: the bubble is still streaming, so Thread would render its one tool call as a
    // running ToolChip — Cursor-style "still working" feedback, not a dead 'done' default.
    let bubble = store.messages().at(-1);
    expect(bubble).toBeDefined();
    if (!bubble) throw new Error('unreachable');
    expect(bubble.streaming).toBe(true);
    expect(bubble.toolCalls).toEqual([{ tool: 'setStyle', selector: '#cta', kind: 'act' }]);
    expect(chipStatusesFor(bubble)).toEqual(['running']);

    port.emit({ type: 'token', text: 'recolored it.' });
    port.emit({ type: 'turn-done', usage: { steps: 0, tokens: 0 } });

    // Turn closed out: same chip, now done — text fully accumulated for Thread to display.
    bubble = store.messages().at(-1);
    if (!bubble) throw new Error('unreachable');
    expect(bubble.streaming).toBe(false);
    expect(bubble.text).toBe('On it — recolored it.');
    // Turn closed, but nothing ever reported whether `setStyle` succeeded, so the chip
    // stays pending rather than claiming success. It becomes 'done' only once a
    // `tool-result` arrives and the store records `ok` on the entry.
    expect(chipStatusesFor(bubble)).toEqual(['pending']);
  });

  it('a tool-result settles its chip: done on ok, failed with the reason on not-ok', async () => {
    vi.resetModules();
    installChromeFake();
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('recolor the hero CTA');

    // loop.ts forwards the SDK's tool-call/tool-result parts correlated by `toolCallId`.
    port.emit({ type: 'tool-call', tool: 'setStyle', selector: '#gone', kind: 'act', id: 'c1' });
    port.emit({ type: 'tool-call', tool: 'setStyle', selector: '#cta', kind: 'act', id: 'c2' });
    expect(chipStatusesFor(bubbleOf(store.messages()))).toEqual(['running', 'running']);

    port.emit({
      type: 'tool-result',
      tool: 'setStyle',
      ok: false,
      id: 'c1',
      error: 'no element matches #gone',
    });
    port.emit({ type: 'tool-result', tool: 'setStyle', ok: true, id: 'c2' });
    port.emit({ type: 'turn-done', usage: { steps: 2, tokens: 40 } });

    const bubble = bubbleOf(store.messages());
    expect(chipStatusesFor(bubble)).toEqual(['failed', 'done']);
    // The failed chip says why — the one thing that makes a red chip actionable.
    expect(bubble.toolCalls[0]?.error).toBe('no element matches #gone');
  });

  it('Stop closes the bubble and stills its chips — no turn-done ever arrives', async () => {
    vi.resetModules();
    installChromeFake();
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
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

  it('a turn that errors mid-stream renders its running chip as an error chip, not done', async () => {
    vi.resetModules();
    installChromeFake();
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('debug the layout');

    port.emit({ type: 'token', text: 'Looking' });
    port.emit({ type: 'tool-call', tool: 'diagnostics', kind: 'read' });
    port.emit({ type: 'error', message: 'provider unreachable' });

    const bubble = store.messages().at(-1);
    if (!bubble) throw new Error('unreachable');
    expect(bubble.streaming).toBe(false);
    expect(bubble.error).toBe('provider unreachable');
    // The turn errored, but that does not prove THIS tool was the thing that failed —
    // attributing the turn error to the last chip is exactly the fabrication we removed.
    expect(chipStatusesFor(bubble)).toEqual(['pending']);
  });

  it('multiple tool calls in one turn: only the newest tracks the bubble, earlier ones stay done', async () => {
    vi.resetModules();
    installChromeFake();
    const port = installPortFake();
    const store = await import('@/entrypoints/sidepanel/stores/chat');

    store.initChatStore();
    await store.send('copy the reference hero');

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
