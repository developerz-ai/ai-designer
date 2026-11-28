import { fireEvent, render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { isNearBottom, Thread } from '@/entrypoints/sidepanel/components/chat/Thread';
import type { ChatMessage } from '@/entrypoints/sidepanel/stores/chat';

// Stick-to-bottom: the thread follows new content only while the reader is at the foot. The old
// check ran inside the effect — AFTER Solid rendered the update — so an update taller than the
// band measured as "scrolled away" and the thread stopped following mid-reply.

function msg(id: string, text: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    segments: [{ kind: 'text', text }],
    text,
    toolCalls: [],
    edits: [],
    streaming: true,
  };
}

/** jsdom does no layout: give the list controllable scroll metrics. */
function fakeScrollMetrics(el: HTMLElement, clientHeight: number) {
  let height = clientHeight;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  return {
    grow: (to: number) => {
      height = to;
    },
  };
}

const microtask = () => new Promise<void>((r) => queueMicrotask(r));

describe('isNearBottom', () => {
  it('is true inside the band and false beyond it', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 830, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 100 })).toBe(false);
  });
});

describe('<Thread> stick-to-bottom', () => {
  it('follows an update taller than the band when the reader was at the foot', async () => {
    const [messages, setMessages] = createSignal<ChatMessage[]>([msg('a', 'hi')]);
    const { container } = render(() => <Thread messages={messages()} />);
    const list = container.querySelector('ul') as HTMLUListElement;
    const metrics = fakeScrollMetrics(list, 100);
    await microtask();

    metrics.grow(1000); // the new bubble is far taller than the 80px band
    setMessages([msg('a', 'hi'), msg('b', 'a very long reply')]);
    await microtask();

    expect(list.scrollTop).toBe(1000);
  });

  it('leaves a reader who scrolled back where they are', async () => {
    const [messages, setMessages] = createSignal<ChatMessage[]>([msg('a', 'hi')]);
    const { container } = render(() => <Thread messages={messages()} />);
    const list = container.querySelector('ul') as HTMLUListElement;
    const metrics = fakeScrollMetrics(list, 100);
    await microtask(); // the mount's own follow-to-bottom
    metrics.grow(1000);
    list.scrollTop = 200;
    fireEvent.scroll(list);

    metrics.grow(1200);
    setMessages([msg('a', 'hi there')]);
    await microtask();

    expect(list.scrollTop).toBe(200);
  });
});
