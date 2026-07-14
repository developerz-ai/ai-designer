import { For, mergeProps, Show } from 'solid-js';
import type { Edit } from '@/shared/changeset';
import type { ToolCallEntry } from '../../stores/chat';
import { Icon } from '../Icon';
import './Message.scss';
import { MarkdownView } from './MarkdownView';
import { ToolChip, type ToolChipStatus } from './ToolChip';

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

/** Assistant text renders through markdown; user/system text renders as plain text (it's an
 *  instruction or notice, not prose). Pure so the role split is unit-testable without mounting
 *  Solid. */
export function showMarkdown(role: MessageRole): boolean {
  return role === 'assistant';
}

/** The "N edits recorded" summary line under a bubble's tool calls. Pure formatting, unit-tested
 *  independent of the `<Icon>` it renders alongside. */
export function editsSummary(count: number): string {
  return `${count} edit${count === 1 ? '' : 's'} recorded`;
}

/** A tool call's chip status, derived rather than stored (the chat store doesn't carry a
 *  per-call status yet — see `ToolChip`'s module comment): only the most recent call in a still-
 *  streaming bubble shows `'running'`; it flips to `'error'` if the turn ended in one, otherwise
 *  `'done'` once the bubble closes out. Earlier calls in the same bubble are always `'done'` —
 *  the SW only ever emits a `tool-call` event once that tool has actually run. */
export function toolCallStatus(
  index: number,
  total: number,
  streaming: boolean,
  hasError: boolean,
): ToolChipStatus {
  const isLast = index === total - 1;
  if (isLast && hasError) return 'error';
  if (isLast && streaming) return 'running';
  return 'done';
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
      <Show when={showMarkdown(props.role)} fallback={<p class="dz-message__text">{props.text}</p>}>
        <MarkdownView text={props.text} />
      </Show>

      <Show when={props.toolCalls.length > 0}>
        <ul class="dz-message__tools">
          <For each={props.toolCalls}>
            {(tc, i) => (
              <li>
                <ToolChip
                  tool={tc.tool}
                  selector={tc.selector}
                  kind={tc.kind}
                  status={toolCallStatus(
                    i(),
                    props.toolCalls.length,
                    props.streaming,
                    Boolean(props.error),
                  )}
                />
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={props.edits.length > 0}>
        <p class="dz-message__edits">
          <Icon name="check" size="sm" />
          {editsSummary(props.edits.length)}
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
