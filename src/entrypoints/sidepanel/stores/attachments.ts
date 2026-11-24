import { createSignal } from 'solid-js';
import { i18n } from '#i18n';
import type { Attachment, TextAttachment } from '@/shared/attachments';
import {
  BIG_PASTE_THRESHOLD_CHARS,
  isSupportedImageType,
  MAX_ATTACHMENTS,
  MAX_IMAGE_ATTACHMENTS,
  MAX_TEXT_ATTACHMENT_CHARS,
  MAX_TEXT_ATTACHMENTS,
} from '@/shared/attachments';
import type { EncodeImageResult } from '../lib/image-encode';
import { queueImageEncode } from '../lib/image-encode-client';

// The DRAFT's attachments — what the next send will carry (`src/shared/attachments.ts`).
//
// A store, not component state (CLAUDE.md "SolidJS + SRP"): three separate affordances feed it
// (the file button, a paste, a drop), two components read it (the tray above the composer, the
// composer's own send gate), and none of them should own the list. Every rule about what may be
// added lives here; `AttachmentTray.tsx` and `Composer.tsx` render and dispatch only.
//
// Local by design and never persisted: an attachment is reference material for ONE instruction. It
// crosses to the service worker on `user-message` and is dropped from here the moment that send is
// accepted — a rejected send keeps it, because re-picking six mockups because the worker was
// restarting is not a thing anyone should have to do.

/** Why an add was refused. Codes so the rules stay testable without matching English. */
export type AddRejection =
  | 'unsupported'
  | 'image-cap'
  | 'text-cap'
  | 'total-cap'
  | 'encode'
  | 'too-large';

/**
 * Which cap (if any) refuses one more attachment of `kind`. `reserved` counts encodes already in
 * flight — without it, dropping ten files at once passes ten capacity checks before the first one
 * finishes and the tray blows past `MAX_IMAGE_ATTACHMENTS`.
 *
 * Pure — exported so the caps are asserted against the SHARED constants rather than rediscovered.
 */
export function capacityDenial(
  items: readonly Attachment[],
  kind: Attachment['kind'],
  reserved = 0,
): 'image-cap' | 'text-cap' | 'total-cap' | null {
  if (items.length + reserved >= MAX_ATTACHMENTS) return 'total-cap';
  if (kind === 'image') {
    const images = items.filter((a) => a.kind === 'image').length + reserved;
    return images >= MAX_IMAGE_ATTACHMENTS ? 'image-cap' : null;
  }
  const texts = items.filter((a) => a.kind === 'text').length;
  return texts >= MAX_TEXT_ATTACHMENTS ? 'text-cap' : null;
}

/** Past this a paste becomes a file rather than field content. Wrapped so the composer asks a
 *  question ("is this a big paste?") instead of re-deriving the rule from a constant. */
export function isBigPaste(text: string): boolean {
  return text.length > BIG_PASTE_THRESHOLD_CHARS;
}

/** Build a text attachment, cutting at {@link MAX_TEXT_ATTACHMENT_CHARS} and SAYING so — the model
 *  is told `truncated`, so it never reasons about a tail it was never shown. Pure. */
export function makeTextAttachment(
  text: string,
  name: string,
  id: string = crypto.randomUUID(),
): TextAttachment {
  const truncated = text.length > MAX_TEXT_ATTACHMENT_CHARS;
  return {
    kind: 'text',
    id,
    name,
    text: truncated ? text.slice(0, MAX_TEXT_ATTACHMENT_CHARS) : text,
    truncated,
  };
}

/** The user-visible sentence for a refusal. The caps interpolate as DATA (a number), which is why
 *  they are read from the shared module here and not written into the locale file. */
export function rejectionMessage(reason: AddRejection, name: string): string {
  switch (reason) {
    case 'unsupported':
      return i18n.t('attachments.error.unsupported', [name]);
    case 'image-cap':
      return i18n.t('attachments.error.imageCap', [String(MAX_IMAGE_ATTACHMENTS)]);
    case 'text-cap':
      return i18n.t('attachments.error.textCap', [String(MAX_TEXT_ATTACHMENTS)]);
    case 'total-cap':
      return i18n.t('attachments.error.totalCap', [String(MAX_ATTACHMENTS)]);
    case 'too-large':
      return i18n.t('attachments.error.tooLarge', [name]);
    default:
      return i18n.t('attachments.error.encode', [name]);
  }
}

const [items, setItems] = createSignal<Attachment[]>([]);
// How many images are being decoded/re-encoded right now. Doubles as the tray's work-in-flight
// indicator and as the capacity reservation above — one number, so the two can never disagree.
const [pending, setPending] = createSignal(0);
// The last refusal, as a sentence. Cleared by the next successful add/remove and by `clear()`.
const [error, setError] = createSignal<string | null>(null);

// Per-draft counters, so two pastes are tellable apart ("Pasted text 1" / "Pasted text 2") and the
// model can be told which is which. Never reused within a draft, even after a removal: a second
// "Pasted text 1" in one conversation is worse than a gap in the numbering.
let textCount = 0;
let imageCount = 0;

export { error as attachmentError, items as attachments, pending as pendingAttachments };

/** Drop the whole draft. Called on a SUCCESSFUL send only (`Composer.tsx`). */
export function clearAttachments(): void {
  setItems([]);
  setPending(0);
  setError(null);
  textCount = 0;
  imageCount = 0;
}

/** Detach exactly one, by the id the tray keys on. */
export function removeAttachment(id: string): void {
  setItems((prev) => prev.filter((a) => a.id !== id));
  setError(null);
}

export function dismissAttachmentError(): void {
  setError(null);
}

/**
 * Promote a big paste into a named text attachment — the "walls of text become files" behaviour.
 * Returns the attachment, or null when a cap refused it (with the reason already on `error`).
 */
export function addBigPaste(text: string): TextAttachment | null {
  const deny = capacityDenial(items(), 'text', pending());
  if (deny) {
    setError(rejectionMessage(deny, ''));
    return null;
  }
  const attachment = makeTextAttachment(
    text,
    i18n.t('attachments.pastedText.name', [String(++textCount)]),
  );
  setError(null);
  setItems((prev) => [...prev, attachment]);
  return attachment;
}

/**
 * Attach image files — from the file button, a drop, or a clipboard image. Unsupported types and
 * cap overruns are REPORTED (`attachmentError()`), never silently dropped: a mockup that vanishes
 * without a word is indistinguishable from a broken feature.
 *
 * Resolves once every accepted file has finished encoding, so a caller may await it.
 */
export async function addFiles(files: readonly File[]): Promise<void> {
  // Cleared HERE and nowhere later in the call: a batch that refuses one file and accepts another
  // must still be able to say why the refused one is missing.
  setError(null);
  const accepted: File[] = [];
  for (const file of files) {
    if (!isSupportedImageType(file.type)) {
      setError(rejectionMessage('unsupported', fileLabel(file)));
      continue;
    }
    // Reserve against what is already in flight, not merely against the settled list.
    const deny = capacityDenial(items(), 'image', pending() + accepted.length);
    if (deny) {
      // Full is full: every remaining file would be refused for the same reason, and repeating
      // the sentence per file just churns the notice.
      setError(rejectionMessage(deny, fileLabel(file)));
      break;
    }
    accepted.push(file);
  }
  if (accepted.length === 0) return;

  setPending((n) => n + accepted.length);
  await Promise.all(accepted.map((file) => encodeOne(file)));
}

async function encodeOne(file: File): Promise<void> {
  const name = fileLabel(file);
  let result: EncodeImageResult;
  try {
    // Queued, off the main thread, with an inline fallback — see `lib/image-encode-client.ts`.
    result = await queueImageEncode(file, { name });
  } catch {
    // The encode path is contracted not to throw; this keeps a broken dep from leaving
    // `pending` stuck above zero and the tray spinning forever.
    result = { ok: false, reason: 'encode' };
  }
  setPending((n) => Math.max(0, n - 1));
  if (!result.ok) {
    setError(rejectionMessage(result.reason === 'too-large' ? 'too-large' : 'encode', name));
    return;
  }
  // Re-checked at commit time: the reservation was taken before the encode, and the user may have
  // attached something else while it ran. The bus enforces the same bound anyway.
  setItems((prev) => (prev.length >= MAX_ATTACHMENTS ? prev : [...prev, result.attachment]));
}

/** A file's own name is DATA and stays out of the locale file; only the fallback for a nameless
 *  clipboard image is copy. */
function fileLabel(file: File): string {
  return file.name.trim() || i18n.t('attachments.pastedImage.name', [String(++imageCount)]);
}
