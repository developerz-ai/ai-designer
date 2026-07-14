import { createEffect, For } from 'solid-js';
import type { ChatMessage } from '../../stores/chat';
import { Message } from './Message';
import './Thread.scss';

// The scrollable message list — renders whatever `stores/chat.ts` hands it and auto-scrolls to
// the newest content, including mid-stream token growth. No store import, no fetching: the SW
// stream is folded into `messages` upstream (CLAUDE.md "SolidJS + SRP" — this just lays them out).
export interface ThreadProps {
  messages: ChatMessage[];
}

export function Thread(props: ThreadProps) {
  let logEl: HTMLUListElement | undefined;

  // Reruns on every fold of the stream (new message, growing token text, streaming flag flip) —
  // reading `.length`/last message's `text`/`streaming` inside the effect is what makes Solid track
  // them as dependencies, not just the array reference changing.
  createEffect(() => {
    const last = props.messages.at(-1);
    void props.messages.length;
    void last?.text;
    void last?.streaming;
    const el = logEl;
    if (!el) return;
    queueMicrotask(() => {
      el.scrollTop = el.scrollHeight;
    });
  });

  return (
    <ul class="dz-thread" ref={logEl}>
      <For each={props.messages}>
        {(m) => (
          <Message
            role={m.role}
            text={m.text}
            streaming={m.streaming}
            error={m.error}
            toolCalls={m.toolCalls}
            edits={m.edits}
          />
        )}
      </For>
    </ul>
  );
}
