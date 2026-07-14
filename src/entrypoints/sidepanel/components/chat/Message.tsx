import { For, mergeProps, Show } from 'solid-js';
import type { Edit } from '@/shared/changeset';
import type { ToolCallEntry } from '../../stores/chat';
import { Icon } from '../Icon';
import './Message.scss';
import { MarkdownView } from './MarkdownView';
import { ToolChip } from './ToolChip';

// One bubble in the thread — user/assistant/system, rendered + dispatch-only (CLAUDE.md "SolidJS +
// SRP": no business logic here, just mapping a `ChatMessage`-shaped prop onto markup). Assistant
// text renders through the bundled `MarkdownView` (no remote fetch/`innerHTML`); user text renders
// as plain text since it's an instruction, not prose. `system` is a local-only notice row (e.g. a
// future "session stopped") — the chat store doesn't emit it yet, but the type is here so `Thread`
// doesn't need a second component when it does.
export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessageProps {
  role: MessageRole;
  text: string;
  streaming?: boolean;
  error?: string;
  toolCalls?: ToolCallEntry[];
  edits?: Edit[];
}

export function Message(rawProps: MessageProps) {
  const props = mergeProps(
    { streaming: false, toolCalls: [] as ToolCallEntry[], edits: [] as Edit[] },
    rawProps,
  );

  return (
    <li
      class="dz-message"
      classList={{
        [`dz-message--${props.role}`]: true,
        'dz-message--streaming': props.streaming,
      }}
    >
      <Show
        when={props.role === 'assistant'}
        fallback={<p class="dz-message__text">{props.text}</p>}
      >
        <MarkdownView text={props.text} />
      </Show>

      <Show when={props.toolCalls.length > 0}>
        <ul class="dz-message__tools">
          <For each={props.toolCalls}>
            {(tc) => (
              <li>
                <ToolChip tool={tc.tool} selector={tc.selector} kind={tc.kind} />
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={props.edits.length > 0}>
        <p class="dz-message__edits">
          <Icon name="check" size="sm" />
          {props.edits.length} edit{props.edits.length === 1 ? '' : 's'} recorded
        </p>
      </Show>

      <Show when={props.error}>
        {(message) => (
          <p class="dz-message__error">
            <Icon name="warning" size="sm" />
            {message()}
          </p>
        )}
      </Show>
    </li>
  );
}
