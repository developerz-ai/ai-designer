import { For, Show } from 'solid-js';
import type { Conversation } from '@/shared/messages';
import { saveMarkdown } from '../stores/changeset';
import { closeConversation, renderConversationMessages } from '../stores/history';
import './ConversationView.scss';
import { Icon } from './Icon';

export interface ConversationViewProps {
  /** `undefined` while `openConversation` is in flight (HistoryPanel's `selectedLoading`) or
   *  after a fetch failure — renders the loading/empty state instead of a stale replay. */
  conversation: Conversation | null;
  loading: boolean;
}

// Read-only replay of one past conversation (slice 08): the message thread as it happened, plus
// its handoff report/PR link if the session produced one. Nothing here is re-playable onto a live
// page — it is a transcript, not an editor (CLAUDE.md "SolidJS + SRP" — render + dispatch only;
// the thread -> display-line flattening is `../stores/history`'s pure `renderConversationMessages`,
// the download is `../stores/changeset`'s existing blob-URL `saveMarkdown`, reused rather than
// reimplemented per the plan's "re-download via blob URL, reuse 07 mechanism").
export function ConversationView(props: ConversationViewProps) {
  function redownload(): void {
    const c = props.conversation;
    if (!c?.report) return;
    saveMarkdown(c.report, `${slugify(c.title)}-report.md`);
  }

  return (
    <div class="dz-convview">
      <div class="dz-convview__header">
        <button type="button" class="dz-convview__back" onClick={closeConversation}>
          <Icon name="back" size="sm" /> History
        </button>
      </div>

      <Show when={props.loading}>
        <p class="dz-convview__hint">
          <Icon name="spinner" size="sm" spin /> Loading conversation…
        </p>
      </Show>

      <Show when={!props.loading && !props.conversation}>
        <p class="dz-convview__hint">Conversation not found.</p>
      </Show>

      <Show when={!props.loading && props.conversation}>
        {(conversation) => (
          <>
            <div class="dz-convview__meta">
              <strong class="dz-convview__title">{conversation().title}</strong>
              <small class="dz-convview__url">{conversation().url}</small>
              <Show when={conversation().mode}>
                {(mode) => <span class={`dz-convview__badge is-${mode()}`}>{mode()}</span>}
              </Show>
              <span class="dz-convview__readonly">
                <Icon name="eye" size="sm" /> Read-only replay
              </span>
            </div>

            <ol class="dz-convview__thread">
              <For each={renderConversationMessages(conversation())}>
                {(line) => (
                  <li class={`dz-convview__line is-${line.role}`}>
                    <span class="dz-convview__role">{line.role}</span>
                    <p class="dz-convview__text">{line.text}</p>
                  </li>
                )}
              </For>
            </ol>

            <div class="dz-convview__footer">
              <Show when={conversation().report}>
                <button type="button" class="dz-convview__action" onClick={redownload}>
                  <Icon name="download" size="sm" /> Re-download report
                </button>
              </Show>
              <Show when={conversation().prLink}>
                {(link) => (
                  <a
                    class="dz-convview__action"
                    href={link()}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Icon name="externalLink" size="sm" /> View PR
                  </a>
                )}
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || 'conversation';
}
