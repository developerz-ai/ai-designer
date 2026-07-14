import { createSignal, For, onMount, Show } from 'solid-js';
import type { ConversationSummary } from '@/shared/messages';
import {
  conversations,
  deleteConversation,
  error,
  hydrateHistory,
  loading,
  openConversation,
  selected,
  selectedLoading,
} from '../stores/history';
import { ConversationView } from './ConversationView';
import './HistoryPanel.scss';
import { Icon } from './Icon';

// Render + dispatch only (CLAUDE.md "SolidJS + SRP"): the list, the favicon/badge/date
// formatting, and the click/delete handlers live here; every read and mutation is an RPC
// through ../stores/history, the thin reflection of the SW's last-10 ring buffer
// (src/agent/history-store.ts). Selecting a row swaps in ConversationView for a read-only
// replay — this component owns only which entry is open, never the replay content itself.
export function HistoryPanel() {
  onMount(() => {
    void hydrateHistory();
  });

  return (
    <div class="dz-history">
      <Show
        when={!selected() && !selectedLoading()}
        fallback={<ConversationView conversation={selected()} loading={selectedLoading()} />}
      >
        <Show when={loading()}>
          <p class="dz-history__hint">
            <Icon name="spinner" size="sm" spin /> Loading history…
          </p>
        </Show>
        <Show when={error()}>
          <p class="dz-history__error">
            <Icon name="warning" size="sm" /> {error()}
          </p>
        </Show>
        <Show when={!loading() && conversations().length === 0}>
          <p class="dz-history__empty">
            No conversations yet — the last 10 will show up here once you chat with the agent.
          </p>
        </Show>

        <ul class="dz-history__list">
          <For each={conversations()}>{(c) => <HistoryRow conversation={c} />}</For>
        </ul>
      </Show>
    </div>
  );
}

function HistoryRow(props: { conversation: ConversationSummary }) {
  const [faviconOk, setFaviconOk] = createSignal(true);

  function open(): void {
    void openConversation(props.conversation.id);
  }

  return (
    <li class="dz-history__item">
      <button type="button" class="dz-history__row" onClick={open}>
        <span class="dz-history__favicon">
          <Show when={faviconOk()} fallback={<Icon name="site" size="sm" />}>
            <img
              src={faviconUrl(props.conversation.url)}
              alt=""
              onError={() => setFaviconOk(false)}
            />
          </Show>
        </span>

        <div class="dz-history__meta">
          <strong class="dz-history__title">{props.conversation.title}</strong>
          <div class="dz-history__sub">
            <Show when={props.conversation.mode}>
              {(mode) => <span class={`dz-history__badge is-${mode()}`}>{mode()}</span>}
            </Show>
            <time class="dz-history__date">{formatDate(props.conversation.createdAt)}</time>
            <Show when={!props.conversation.prLink && props.conversation.hasReport}>
              <span class="dz-history__reportbadge">
                <Icon name="report" size="sm" /> Report
              </span>
            </Show>
          </div>
        </div>
      </button>

      <Show when={props.conversation.prLink}>
        {(link) => (
          <a class="dz-history__pr" href={link()} target="_blank" rel="noopener noreferrer">
            <Icon name="externalLink" size="sm" /> PR
          </a>
        )}
      </Show>

      <button
        type="button"
        class="dz-history__delete"
        aria-label={`Delete ${props.conversation.title}`}
        onClick={() => void deleteConversation(props.conversation.id)}
      >
        <Icon name="trash" size="sm" />
      </button>
    </li>
  );
}

/** Direct site favicon (no third-party lookup service — CLAUDE.md "no remote code" is about
 *  script execution, but this keeps history from depending on anything but the site itself).
 *  `null` for an unparseable `url` falls straight to the `Icon` fallback. */
function faviconUrl(url: string): string | undefined {
  try {
    return `${new URL(url).origin}/favicon.ico`;
  } catch {
    return undefined;
  }
}

function formatDate(createdAt: number): string {
  return new Date(createdAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
