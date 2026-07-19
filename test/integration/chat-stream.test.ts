import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolCallStatus } from '@/entrypoints/sidepanel/components/chat/Message';
import type { ChatMessage } from '@/entrypoints/sidepanel/stores/chat';
import type { PanelToSw, SwToPanel } from '@/shared/messages';

// Integration: a mocked `SwToPanel` stream, the way background.ts's real `runTurn` forwarding
// emits it, folded through the real chat store (`stores/chat.ts`) end to end — proving the two
// hops Thread/Message/ToolChip actually render from compose the way task #70 asks: streamed
// text accumulates into a bubble, a tool-call becomes a chip-shaped entry, and that chip's
// derived status walks running -> done across the turn. Each hop already has its own unit
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

/** What Thread hands each tool call's chip, index-aware exactly as `Message`'s `<For>` derives
 *  it — the same call `Message.tsx` makes for every entry it renders. */
function chipStatusesFor(m: ChatMessage): string[] {
  return m.toolCalls.map((_, i) =>
    toolCallStatus(i, m.toolCalls.length, m.streaming, Boolean(m.error)),
  );
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
    expect(chipStatusesFor(bubble)).toEqual(['done']);
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
    expect(chipStatusesFor(bubble)).toEqual(['error']);
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
    expect(chipStatusesFor(bubble)).toEqual(['done', 'done', 'running']);

    port.emit({ type: 'turn-done', usage: { steps: 0, tokens: 0 } });
    bubble = store.messages().at(-1);
    if (!bubble) throw new Error('unreachable');
    expect(chipStatusesFor(bubble)).toEqual(['done', 'done', 'done']);
  });
});
