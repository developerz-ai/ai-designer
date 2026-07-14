import { onMount, Show } from 'solid-js';
import { error, initChatStore, messages, send as sendMessage } from '../stores/chat';
import './ChatPanel.scss';
import { Composer } from './chat/Composer';
import { EmptyState } from './chat/EmptyState';
import type { Suggestion } from './chat/SuggestionChips';
import { Thread } from './chat/Thread';

// The design conversation. Sends user messages to the service worker over `stores/chat.ts` and
// renders the streamed reply (tokens/tool chips/recorded edits) as it assembles via `chat/Thread`
// — the SW is the only source of truth for what the agent did, this component just renders +
// dispatches (CLAUDE.md "SolidJS + SRP"). Before any turn has run this session, `EmptyState`
// (with its `SuggestionChips`) takes the Thread's place; `Composer` owns the input, model
// quick-switch, and picker-attach affordance.
export function ChatPanel() {
  onMount(() => {
    initChatStore();
  });

  function selectSuggestion(suggestion: Suggestion): void {
    void sendMessage(suggestion.prompt, suggestion.mode);
  }

  return (
    <div class="dz-chat">
      <Show
        when={messages().length > 0}
        fallback={<EmptyState onSelectSuggestion={selectSuggestion} />}
      >
        <Thread messages={messages()} />
      </Show>

      <Show when={error()}>{(msg) => <p class="dz-chat__error">{msg()}</p>}</Show>

      <Composer />
    </div>
  );
}
