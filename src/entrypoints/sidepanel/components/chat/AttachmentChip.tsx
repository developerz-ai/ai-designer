import { Show } from 'solid-js';
import { i18n } from '#i18n';
import type { Attachment } from '@/shared/attachments';
import { Icon } from '../Icon';
import './AttachmentChip.scss';

// One attached piece of reference material — a mockup, or a big paste that became a file. The
// sibling of `ContextChip`: same grammar (a small removable capsule naming one thing the agent
// will be given), different payload. An element reference points AT the page; an attachment is
// something the user brought to it.
//
// Presentational + dispatch-only (CLAUDE.md "SolidJS + SRP"): the list, the caps and the encoding
// all live in `stores/attachments.ts` / `lib/image-encode.ts`. Used twice — live in the composer's
// tray (with a remove button) and read-only inside a sent turn (`Message.tsx`), which is the whole
// reason it is its own component.

/** Rounded KB for a text attachment's size line. Characters, not bytes on the wire: what the user
 *  pasted is what they recognise, and a UTF-8 byte count would say something different for the
 *  same paste. Pure — unit-tested without mounting Solid. */
export function sizeInKb(chars: number): string {
  return (Math.max(chars, 0) / 1024).toFixed(1);
}

/** The chip's second line: pixel dimensions for an image (because "match this" usually means
 *  matching a layout AT a width), size for a paste, plus the truncation flag when the paste was
 *  cut. Pure. */
export function attachmentDetail(attachment: Attachment): string {
  if (attachment.kind === 'image') {
    return i18n.t('attachments.detail.dimensions', [
      String(attachment.width),
      String(attachment.height),
    ]);
  }
  const size = i18n.t('attachments.detail.size', [sizeInKb(attachment.text.length)]);
  return attachment.truncated ? i18n.t('attachments.detail.truncated', [size]) : size;
}

export interface AttachmentChipProps {
  attachment: Attachment;
  /** Absent ⇒ read-only. A turn already sent cannot un-attach what it was sent with. */
  onRemove?: () => void;
}

export function AttachmentChip(props: AttachmentChipProps) {
  return (
    <span
      class="dz-attachment-chip"
      classList={{ 'dz-attachment-chip--truncated': isTruncated(props.attachment) }}
    >
      <Show
        when={props.attachment.kind === 'image' ? props.attachment : undefined}
        fallback={
          <span class="dz-attachment-chip__glyph" aria-hidden="true">
            <Icon name="report" size="sm" class="dz-icon--fixed" />
          </span>
        }
      >
        {(image) => (
          // `alt=""`: the file name sits immediately beside it as real text, so a described
          // thumbnail would announce the same thing twice. The src is the attachment's OWN
          // `data:` URL — nothing is fetched, which is what keeps this CSP-clean.
          <img class="dz-attachment-chip__thumb" src={image().dataUrl} alt="" />
        )}
      </Show>

      <span class="dz-attachment-chip__body">
        <span class="dz-attachment-chip__name">{props.attachment.name}</span>
        <span class="dz-attachment-chip__detail">{attachmentDetail(props.attachment)}</span>
      </span>

      <Show when={props.onRemove !== undefined}>
        <button
          type="button"
          class="dz-attachment-chip__dismiss"
          // Names WHICH attachment it detaches: six identical "Remove" buttons in a row is a
          // tray a screen-reader user cannot navigate.
          aria-label={i18n.t('attachments.remove.ariaLabel', [props.attachment.name])}
          onClick={() => props.onRemove?.()}
        >
          <Icon name="close" size="sm" class="dz-icon--fixed" />
        </button>
      </Show>
    </span>
  );
}

function isTruncated(attachment: Attachment): boolean {
  return attachment.kind === 'text' && attachment.truncated;
}
