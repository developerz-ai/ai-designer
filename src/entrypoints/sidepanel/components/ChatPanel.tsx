import { createSignal, For } from 'solid-js';
import './ChatPanel.scss';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

// The design conversation. Sends user messages to the service worker, renders
// the streamed reply + recorded edits, and surfaces the Ship action.
// Wiring to the SW message bus is TODO — see docs/idea/agent.md.
export function ChatPanel() {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [draft, setDraft] = createSignal('');

  function send() {
    const text = draft().trim();
    if (!text) return;
    setMessages((m) => [...m, { role: 'user', text }]);
    setDraft('');
    // TODO: chrome.runtime.sendMessage({ type: 'user-message', text })
    //       and stream SwToPanel tokens back into `messages`.
  }

  return (
    <div class="dz-chat">
      <ul class="dz-chat__log">
        <For each={messages()}>
          {(m) => <li classList={{ [`is-${m.role}`]: true }}>{m.text}</li>}
        </For>
      </ul>

      <form
        class="dz-chat__compose"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          type="text"
          placeholder="Tell the agent what to change…"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
