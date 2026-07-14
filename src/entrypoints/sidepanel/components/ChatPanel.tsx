import { createSignal, For, onMount, Show } from 'solid-js';
import {
  error,
  initChatStore,
  messages,
  send as sendMessage,
  stopTurn,
  streaming,
} from '../stores/chat';
import './ChatPanel.scss';

// The design conversation. Sends user messages to the service worker over `stores/chat.ts` and
// renders the streamed reply (tokens/tool chips/recorded edits) as it assembles — the SW is the
// only source of truth for what the agent did, this component just renders + dispatches (CLAUDE.md
// "SolidJS + SRP"). Subcomponents (Thread/Message/ToolChip/Composer) + the full Leo-style layout
// land in a later slice; this is the minimal wiring to the store.
export function ChatPanel() {
  const [draft, setDraft] = createSignal('');

  onMount(() => {
    initChatStore();
  });

  function submit() {
    const text = draft();
    if (!text.trim() || streaming()) return;
    setDraft('');
    void sendMessage(text);
  }

  return (
    <div class="dz-chat">
      <ul class="dz-chat__log">
        <For each={messages()}>
          {(m) => (
            <li classList={{ [`is-${m.role}`]: true, 'is-streaming': m.streaming }}>
              {m.text}
              <Show when={m.error}>{(msg) => <p class="dz-chat__error">{msg()}</p>}</Show>
            </li>
          )}
        </For>
      </ul>

      <Show when={error()}>{(msg) => <p class="dz-chat__error">{msg()}</p>}</Show>

      <form
        class="dz-chat__compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          placeholder="Tell the agent what to change…"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <Show
          when={streaming()}
          fallback={
            <button type="submit" disabled={!draft().trim()}>
              Send
            </button>
          }
        >
          <button type="button" onClick={() => void stopTurn()}>
            Stop
          </button>
        </Show>
      </form>
    </div>
  );
}
