import { mergeProps, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { Edit } from '@/shared/changeset';
import type { ToolCallEntry } from '../../stores/chat';
import { Icon } from '../Icon';
import './Message.scss';
import { MarkdownView } from './MarkdownView';
import { ToolCallList } from './ToolCallList';

// One turn in the thread — user/assistant/system, rendered + dispatch-only (CLAUDE.md "SolidJS +
// SRP": no business logic here, just mapping a `ChatMessage`-shaped prop onto markup). Assistant
// text renders through the bundled `MarkdownView` (no remote fetch/`innerHTML`); user text renders
// as plain text since it's an instruction, not prose. Tool activity is delegated to
// `ToolCallList` — it takes the opposite (card) grammar to the assistant's unboxed prose and owns
// its own status derivation. `system` is a local-only notice row (e.g. a future "session
// stopped") — the chat store doesn't emit it yet, but the type is here so `Thread` doesn't need a
// second component when it does.
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

// Speaker names, resolved once at module scope (mirrors `ToolChip`'s KIND_LABEL). `system` has
// none by design: it is a local notice, not a turn anyone said.
const SPEAKER: Partial<Record<MessageRole, string>> = {
  user: i18n.t('thread.speaker.user'),
  assistant: i18n.t('thread.speaker.assistant'),
};

/** Who this turn belongs to, as a word — the correct expression of what `role="user"` /
 *  `role="assistant"` was trying to say. Those are not ARIA roles, so browsers dropped them and
 *  every turn fell back to a generic element with nothing to tell the speakers apart. Rendered
 *  visually-hidden, so it changes nothing on screen. */
export function speakerLabel(role: MessageRole): string | undefined {
  return SPEAKER[role];
}

/** The "N edits recorded" summary line under a turn's tool calls. Pure formatting, unit-tested
 *  independent of the `<Icon>` it renders alongside. */
export function editsSummary(count: number): string {
  return i18n.t('message.editsSummary', count);
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
      {/* First child, so a screen reader hears who is talking before what they said. Hidden
          visually — on screen, position and tone already say it. It lives here rather than in the
          announcer: the live region mirrors the reply text only (see Thread.tsx), so no turn is
          ever announced with a stray speaker name. */}
      <Show when={speakerLabel(props.role)}>
        {(speaker) => <span class="dz-message__speaker">{speaker()}</span>}
      </Show>

      <Show when={showMarkdown(props.role)} fallback={<p class="dz-message__text">{props.text}</p>}>
        <MarkdownView text={props.text} />
      </Show>

      {/* Renders nothing at all for a turn with no tool calls — no empty list node. */}
      <ToolCallList calls={props.toolCalls} streaming={props.streaming} />

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
