import { createMemo, For, Index, Match, mergeProps, Show, Switch } from 'solid-js';
import { i18n } from '#i18n';
import type { Attachment } from '@/shared/attachments';
import type { Edit } from '@/shared/changeset';
import type { Segment, ToolCallEntry } from '../../stores/chat';
import { Icon } from '../Icon';
import { AttachmentChip } from './AttachmentChip';
import './Message.scss';
import { MarkdownView } from './MarkdownView';
import { ToolCallList } from './ToolCallList';
import { workingPhaseKey } from './turn-phase';

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
  /** The turn's body in the order it actually happened: prose, the tool burst it led into, more
   *  prose… (`stores/chat.ts` `Segment`). When present it IS the body — `text`/`toolCalls` are
   *  that same content flattened, kept for the working-line gate and turn-phase. When absent
   *  (a caller that predates segments, e.g. a bare notice), the flat props render as one text
   *  block + one chip group — see `fallbackSegments`. */
  segments?: Segment[];
  /** The turn's calls FLAT — what `turn-phase.ts` derives the working line from, and the body's
   *  fallback shape when `segments` is absent. */
  toolCalls?: ToolCallEntry[];
  edits?: Edit[];
  /** Reference material this turn was SENT with. Read-only here — a turn already sent cannot
   *  un-attach what it carried. Absent on every rehydrated turn (`threadToMessages` rebuilds from
   *  the SW's thread view, which carries no attachment bytes) and that is correct, not a gap to
   *  paper over. */
  attachments?: Attachment[];
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

/** The body a caller WITHOUT ordered segments gets: the flat props as one text block then one
 *  chip group — exactly the pre-segment layout. Pure (unit-testable without mounting), and the
 *  only shape-mapping this component does: the real interleave is folded upstream in the store
 *  (CLAUDE.md "SolidJS + SRP"). */
export function fallbackSegments(text: string, toolCalls: ToolCallEntry[]): Segment[] {
  return [
    ...(text.length > 0 ? [{ kind: 'text', text } as const] : []),
    ...(toolCalls.length > 0 ? [{ kind: 'tools', calls: toolCalls } as const] : []),
  ];
}

/** Narrowing accessors, so the JSX reads a segment without a cast. The wrong kind yields the
 *  empty value — unreachable behind the `kind` switch, but total functions keep TS honest. */
export function segmentText(segment: Segment): string {
  return segment.kind === 'text' ? segment.text : '';
}

export function segmentCalls(segment: Segment): ToolCallEntry[] {
  return segment.kind === 'tools' ? segment.calls : [];
}

export function Message(rawProps: MessageProps) {
  const props = mergeProps(
    {
      streaming: false,
      toolCalls: [] as ToolCallEntry[],
      edits: [] as Edit[],
      attachments: [] as Attachment[],
    },
    rawProps,
  );

  // The ordered body when the store provided one, the flat props re-shaped when it did not.
  const segments = createMemo(
    () => props.segments ?? fallbackSegments(props.text, props.toolCalls),
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

      {/* Says what is happening while the reply is still empty — and ONLY while it is empty: the
          moment the first token lands, the reply text itself (with its trailing caret) answers
          "is it alive?", and a status line under a growing answer reads as a second speaker. The
          gap before the first token is exactly when a user is most likely to think the panel has
          hung. The words come from the turn's own tool calls (`turn-phase.ts`) and CHANGE as the
          turn moves: a single hardcoded "Editing the page…" was false for most of that gap —
          every turn reads first — and a sentence that never changes is indistinguishable from a
          hung panel. */}
      <Show when={props.streaming && props.role === 'assistant' && props.text.length === 0}>
        <p class="dz-message__working">
          <span class="dz-message__dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {i18n.t(workingPhaseKey(props.toolCalls))}
        </p>
      </Show>

      {/* What the user handed over, above their words — the order a chat client uses, and the
          order they were composed in. Read-only: no remove button on a turn already sent. */}
      <Show when={props.attachments.length > 0}>
        <ul class="dz-message__attachments">
          <For each={props.attachments}>
            {(attachment) => (
              <li class="dz-message__attachment">
                <AttachmentChip attachment={attachment} />
              </li>
            )}
          </For>
        </ul>
      </Show>

      {/* The turn's body, in the order it happened: prose, then the tool burst it led into, then
          the next prose… `Index` (position-keyed), for the same reason as Thread/MarkdownView: the
          store replaces the TAIL segment object on every fold, so keying by identity would
          dispose+remount the streaming segment per token — and remounting an earlier ToolCallList
          would also reset its collapse state. Segments only append and only the tail changes, so
          position keying is exact. Each `tools` segment gets its own ToolCallList — its own
          header count and its own collapse, scoped to that burst. */}
      <Index each={segments()}>
        {(segment) => (
          <Switch>
            <Match when={segment().kind === 'text'}>
              <Show
                when={showMarkdown(props.role)}
                fallback={<p class="dz-message__text">{segmentText(segment())}</p>}
              >
                <MarkdownView text={segmentText(segment())} />
              </Show>
            </Match>
            <Match when={segment().kind === 'tools'}>
              {/* Renders nothing at all for an empty group — no empty list node. */}
              <ToolCallList calls={segmentCalls(segment())} streaming={props.streaming} />
            </Match>
          </Switch>
        )}
      </Index>

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
