// What the user hands the agent alongside an instruction — the ingress that was missing.
//
// THE GAP THIS CLOSES: the agent has been multimodal since slice 13, but only outward — it can
// screenshot the page (`agent/tools/vision.ts`) and enumerate the page's own images
// (`dom/images.ts`). Nothing ever carried a picture the OTHER way. "Redesign this section to match
// this mockup" was unsayable: the user could describe a design in prose or not at all. This schema
// is the reference material's transport, panel -> service worker, on `UserMessage.attachments`.
//
// Two kinds, because a conversation carries two kinds of bulky thing:
//   • `image` — a mockup, a screenshot of a competitor, a Figma export. Several at once is the
//     normal case (desktop + mobile, or before/after), so the cap is a handful, not one.
//   • `text`  — a big paste. Pasting 800 lines of CSS into a one-line composer destroys the
//     composer; the panel turns anything past a threshold into a named text attachment instead,
//     the way a chat client turns a wall of text into a file.
//
// ONE-SHOT, by design. An attachment is consumed by the turn it was sent on and then dropped: the
// service worker holds the bytes in memory for that turn, hands them to the model, and never writes
// them to any `chrome.storage.*` area. The persisted thread keeps a text marker naming the
// attachment, not the payload. The reason is cost, not storage hygiene — a chat resends its whole
// conversation on every turn, so an image retained in the thread is paid for on EVERY subsequent
// turn rather than once. Losing attachments when the extension closes is accepted; re-attaching is
// one drag.
//
// Bounds are load-bearing, not decorative. This payload crosses `chrome.runtime` as JSON, and one
// unbounded paste would evict a design session. The panel fits images into the box below and
// re-encodes only those that need it (see `sidepanel/lib/image-encode.ts`, which does the work in a
// Worker so a six-mockup drop can't freeze the panel); these caps are the wall behind that,
// enforced at the bus boundary where a malformed or hostile payload actually arrives.

import { z } from 'zod';

/** Raster formats a vision model will accept. `image/svg+xml` is deliberately absent: SVG is a
 *  document with script and remote-fetch surface, not a bitmap, and no provider decodes it. */
export const ATTACHMENT_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

/** Max images per message. Two viewports plus a couple of details is a real brief; a dozen is a
 *  cost accident. */
export const MAX_IMAGE_ATTACHMENTS = 6;
/** Max text (big-paste) attachments per message. */
export const MAX_TEXT_ATTACHMENTS = 4;
/** Combined cap across both kinds — the composer's tray, and what the SW will accept. */
export const MAX_ATTACHMENTS = 8;

/** The box an attached image is downscaled to FIT INSIDE before encoding, aspect ratio preserved.
 *  Not a longest-edge cap: a 4000×900 banner and a 900×4000 mobile shot are different problems, and
 *  a single edge limit lets one dimension stay enormous. Above this no mainstream vision model
 *  gains detail — it tiles the image and pays for the pixels either way.
 *
 *  An image that ALREADY fits is passed through untouched — original bytes, original type, no
 *  canvas round-trip. Not merely "not upscaled": re-encoding a lossless PNG screenshot that needed
 *  no resizing would introduce lossy artefacts in the fine text and hairlines of the one image
 *  whose entire job is to be matched precisely. */
export const IMAGE_MAX_WIDTH = 1600;
export const IMAGE_MAX_HEIGHT = 1200;
/** Per-image ceiling on the encoded data URL, in characters (base64 ≈ 4/3 of the bytes). ~2.7MB
 *  of characters ≈ 2MB of image, which a WebP fitted to the box above clears with room to spare. */
export const MAX_IMAGE_DATA_URL_CHARS = 2_800_000;
/** Per-text-attachment character ceiling. Past this the panel truncates and says so. */
export const MAX_TEXT_ATTACHMENT_CHARS = 100_000;
/** Chars of pasted text past which the composer converts the paste into a text attachment rather
 *  than dropping it into the field. Roughly a screenful of prose. */
export const BIG_PASTE_THRESHOLD_CHARS = 1_500;

/** A `data:` URL, and only a `data:` URL. An `http(s)` reference would make the service worker
 *  fetch a user-supplied origin to build a model message — a request the user never authorized and
 *  a way to smuggle traffic out of a "the page goes only to your model" product. */
const DataUrl = z
  .string()
  .max(MAX_IMAGE_DATA_URL_CHARS)
  .refine((v) => /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v), {
    message: 'attachment image must be a base64 data: URL of a supported raster type',
  });

/** A reference image the user attached — a mockup to match, a competitor screenshot, a detail crop. */
export const ImageAttachment = z.object({
  kind: z.literal('image'),
  /** Panel-minted, stable for the life of the draft — the tray keys on it and removal targets it. */
  id: z.string().min(1).max(64),
  /** Original file name when there was one ("hero-v3.png"), else a panel-generated label. Shown in
   *  the tray, and named to the model so "match the second mockup" resolves. */
  name: z.string().min(1).max(200),
  mediaType: z.enum(ATTACHMENT_IMAGE_TYPES),
  /** The encoded image, post-downscale. */
  dataUrl: DataUrl,
  /** Post-downscale pixel dimensions — the model is told them, because "match this" often means
   *  matching a layout at a width. */
  width: z.number().int().positive().max(20_000),
  height: z.number().int().positive().max(20_000),
});
export type ImageAttachment = z.infer<typeof ImageAttachment>;

/** A big paste, promoted out of the composer into a named blob of text. */
export const TextAttachment = z.object({
  kind: z.literal('text'),
  id: z.string().min(1).max(64),
  /** "Pasted text 1", or the dropped file's name. */
  name: z.string().min(1).max(200),
  text: z.string().max(MAX_TEXT_ATTACHMENT_CHARS),
  /** True when the source was longer than {@link MAX_TEXT_ATTACHMENT_CHARS} and got cut — the
   *  model is told, so it never reasons about the tail as if it had seen it. */
  truncated: z.boolean().default(false),
});
export type TextAttachment = z.infer<typeof TextAttachment>;

export const Attachment = z.discriminatedUnion('kind', [ImageAttachment, TextAttachment]);
export type Attachment = z.infer<typeof Attachment>;

/** The bus-level list: bounded in count here, in size per-item above. Absent and empty must stay
 *  distinguishable nowhere downstream — both mean "nothing attached" — so consumers may treat
 *  `undefined` and `[]` identically. */
export const Attachments = z.array(Attachment).max(MAX_ATTACHMENTS);
export type Attachments = z.infer<typeof Attachments>;

/** True when `type` is a raster format this schema accepts — the panel's file-picker/paste/drop
 *  filter, shared so the UI rejects exactly what the bus would reject. */
export function isSupportedImageType(
  type: string,
): type is (typeof ATTACHMENT_IMAGE_TYPES)[number] {
  return (ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(type);
}
