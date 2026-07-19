import { createMemo, onMount, Show } from 'solid-js';
import { error, initChatStore, messages, send as sendMessage, usage } from '../stores/chat';
import { initFocusStore } from '../stores/focus';
import { initReadinessStore } from '../stores/readiness';
import './ChatPanel.scss';
import { Composer } from './chat/Composer';
import { EmptyState } from './chat/EmptyState';
import type { Suggestion } from './chat/SuggestionChips';
import { Thread } from './chat/Thread';
import { ShipBar } from './ShipBar';
import { TaskTimeline } from './TaskTimeline';
import { UsageMeter } from './UsageMeter';

// The design conversation — pure composition, no business logic (CLAUDE.md "SolidJS + SRP").
// Wires the three stores its subtree renders: `stores/chat.ts` (thread + streaming, this
// component's own `messages`/`error`), `stores/focus.ts` (the picker pin `Composer`/`ContextChip`
// read) and `stores/readiness.ts` (the provider/model/MCP state `Composer`'s model picker and
// `ShipBar`'s "Send to…" reflect) — all three `init*` calls are idempotent, so wiring them here
// too keeps ChatPanel self-sufficient regardless of what else happens to be mounted (header,
// composer) rather than relying on a sibling to have called them first.
// Before any turn has run this session, `EmptyState` (with its `SuggestionChips`) takes the
// Thread's place; once a thread exists, `ShipBar` + `TaskTimeline` (07) sit at its foot — Download
// brief is always available once there's something to report, Ship/Send to… only act once a
// backend is connected (ShipBar's own gate). `Composer` owns the input, model quick-switch, and
// picker-attach affordance.
export function ChatPanel() {
  onMount(() => {
    initChatStore();
    initFocusStore();
    initReadinessStore();
  });

  const hasThread = createMemo(() => messages().length > 0);

  function selectSuggestion(suggestion: Suggestion): void {
    void sendMessage(suggestion.prompt, suggestion.mode);
  }

  return (
    <div class="dz-chat">
      <Show when={hasThread()} fallback={<EmptyState onSelectSuggestion={selectSuggestion} />}>
        <Thread messages={messages()} />
        <TaskTimeline />
        <ShipBar />
        <UsageMeter usage={usage()} />
      </Show>

      <Show when={error()}>{(msg) => <p class="dz-chat__error">{msg()}</p>}</Show>

      <Composer />
    </div>
  );
}
