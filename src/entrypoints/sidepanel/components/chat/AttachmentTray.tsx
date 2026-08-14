import { createMemo, For, Show } from 'solid-js';
import { i18n } from '#i18n';
import { MAX_TEXT_ATTACHMENT_CHARS } from '@/shared/attachments';
import {
  attachmentError,
  attachments,
  dismissAttachmentError,
  pendingAttachments,
  removeAttachment,
} from '../../stores/attachments';
import { Icon } from '../Icon';
import { AttachmentChip } from './AttachmentChip';
import './AttachmentTray.scss';

// The draft's reference material, as a row above the composer — the sibling of `ElementRefs`.
// Same shape of statement ("this is what the next message carries"), the other half of the
// grammar: `ElementRefs` shows what was pinned ON the page, this shows what was brought TO it.
//
// Render + dispatch only (CLAUDE.md "SolidJS + SRP"): the list, the caps, the encoding and every
// refusal sentence come from `stores/attachments.ts`. Zero props, like `ElementRefs` — three
// different affordances feed this list and none of them is its parent.

export function AttachmentTray() {
  const items = createMemo(() => attachments());
  const busy = createMemo(() => pendingAttachments());
  // One notice for the tray, not one per chip: the chips already carry a "· truncated" detail
  // line; this says what truncation MEANT, once.
  const truncated = createMemo(() => items().some((a) => a.kind === 'text' && a.truncated));

  return (
    <Show when={items().length > 0 || busy() > 0 || attachmentError() !== null}>
      <div class="dz-attachment-tray">
        <Show when={items().length > 0 || busy() > 0}>
          <ul class="dz-attachment-tray__list" aria-label={i18n.t('attachments.list.ariaLabel')}>
            <For each={items()}>
              {(attachment) => (
                <li class="dz-attachment-tray__item">
                  <AttachmentChip
                    attachment={attachment}
                    onRemove={() => removeAttachment(attachment.id)}
                  />
                </li>
              )}
            </For>
            {/* Encoding a 12MP screenshot takes a beat. Without this the tray sits empty after a
                drop and the drop reads as having done nothing. */}
            <Show when={busy() > 0}>
              <li class="dz-attachment-tray__item">
                <span class="dz-attachment-tray__pending">
                  <Icon name="spinner" size="sm" class="dz-icon--fixed" spin />
                  {i18n.t('attachments.encoding', busy())}
                </span>
              </li>
            </Show>
          </ul>
        </Show>

        <Show when={truncated()}>
          <p class="dz-attachment-tray__notice">
            {i18n.t('attachments.truncatedNotice', [
              MAX_TEXT_ATTACHMENT_CHARS.toLocaleString('en-US'),
            ])}
          </p>
        </Show>

        {/* `role="status"` — a refusal has to reach a screen-reader user who never sees the row.
            Polite by definition of the role: nothing here interrupts a turn in flight. */}
        <Show when={attachmentError()}>
          {(message) => (
            <p class="dz-attachment-tray__error" role="status">
              <Icon name="warning" size="sm" class="dz-icon--fixed" />
              <span class="dz-attachment-tray__error-text">{message()}</span>
              <button
                type="button"
                class="dz-attachment-tray__dismiss"
                aria-label={i18n.t('attachments.error.dismiss.ariaLabel')}
                onClick={() => dismissAttachmentError()}
              >
                <Icon name="close" size="sm" class="dz-icon--fixed" />
              </button>
            </p>
          )}
        </Show>
      </div>
    </Show>
  );
}
