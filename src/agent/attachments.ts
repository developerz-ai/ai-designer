// Attachment ingress — turning what the user handed over into what the model actually reads.
//
// THE GAP THIS CLOSES: the agent has been multimodal OUTWARD only. It screenshots the page
// (`agent/vision.ts`) and enumerates the page's own `<img>`s (`dom/images.ts`), so pictures only
// ever flowed page -> model. Nothing carried a picture the other way, and `background.ts` built the
// turn's user message as a PLAIN STRING — so "redesign this hero to match this mockup" was
// unsayable. `src/shared/attachments.ts` is the transport; this module is the mapping: bus
// `Attachment[]` + the already-grounded instruction text -> the turn's `ModelMessage` content.
//
// Pure + chrome-free + no I/O, like `focus-context.ts`: the same input must produce the same content
// every time, and every function here is total (odd input yields degraded text, never a throw) —
// this runs on the hot path of every send and a throw here would lose the user's instruction.
//
// ONE-SHOT IMAGES — the shape of the whole feature, and the reason there are TWO renderers here:
//
//   `toUserContent`       -> what the MODEL reads on the attaching turn: real image parts.
//   `toStoredUserContent` -> what the THREAD keeps forever: a plain string, markers where the
//                            images were, never a byte of image data.
//
// An attachment is consumed by exactly the turn it was sent on, then dropped. The bytes live in
// service-worker memory for that turn's lifetime and are never written to `chrome.storage.*`, never
// to IndexedDB, nowhere. This is a deliberate cost decision, not a limitation we failed to lift: a
// chat resends the WHOLE conversation every turn, so an image kept in the thread is re-billed on
// every subsequent turn, forever. One-shot means the user pays for a mockup exactly once. What
// carries the design forward past turn 1 is the agent's answer and the edits it recorded; if the
// user wants the image looked at again, they attach it again — and the panel still shows it on the
// turn it was sent, so re-attaching is obvious.
//
// The consequence to keep honest: a turn that dies mid-flight resumes from the persisted thread with
// no bytes. The marker therefore has to read correctly ON ITS OWN — it says an image was attached
// and cannot be seen now, and it never tells the model to "re-capture" something it never captured
// (see `thread-compact.ts` `USER_MEDIA_OMITTED_PLACEHOLDER` for the same wording problem).
//
// TWO DECISIONS THAT LOOK LIKE DETAILS AND ARE NOT:
//
//  1. NO ATTACHMENTS ⇒ RETURN THE STRING UNCHANGED. Not an optimisation — a compatibility
//     requirement. Every existing turn, every persisted thread and every prompt-cache prefix
//     already holds a plain-string user message; wrapping every turn in a one-element array would
//     change those bytes and invalidate the cached prefix on the very first send after this ships
//     (see the prefix-cache note at `background.ts` around the `user-message` append, and
//     `thread-compact.ts`'s module header).
//
//  2. TEXT ATTACHMENTS ARE INLINED INTO THE TEXT PART, NEVER EMITTED AS `{type:'file'}` WITH
//     `text/plain`. OpenAI-compatible gateways vary wildly on non-image `file` parts and several
//     answer 400, which would fail the WHOLE turn because the user pasted something long. A named,
//     fenced block inside the text part is understood by every model and can never be rejected.
//     (Images have no such problem: a `file` part with an `image/*` mediaType lowers to the
//     universally supported image part — the agent sends its own screenshots the same way, #182.)

import type { modelMessageSchema } from 'ai';
import type { z } from 'zod';
import type { Attachment, ImageAttachment, TextAttachment } from '@/shared/attachments';

// --- part-type views (derived, so they can never drift from the SDK schema) -------------------
// Same technique as `thread-compact.ts:30-36`: the part types are read OFF the schema the session
// thread is validated against, rather than hand-rolled here. If AI SDK changes the shape of a user
// part, this file stops compiling instead of silently emitting something the provider rejects.

type ModelMessage = z.infer<typeof modelMessageSchema>;
type UserModelMessage = Extract<ModelMessage, { role: 'user' }>;

/** One part of a multipart user message: `text`, `image`, or `file`. We only ever emit `text` and
 *  image-typed `file` parts — see decision 2 in the header. */
export type UserContentPart = Exclude<UserModelMessage['content'], string>[number];

// --- grounding line ---------------------------------------------------------------------------

const isImage = (a: Attachment): a is ImageAttachment => a.kind === 'image';
const isText = (a: Attachment): a is TextAttachment => a.kind === 'text';

/** `(1) "hero-desktop.png" 1536×864` — index + name + pixel dimensions. The INDEX makes "match the
 *  second mockup" resolve; the NAME makes "the mobile one" resolve; the DIMENSIONS matter because
 *  "match this" usually means matching a layout AT A WIDTH, and the model cannot measure an image
 *  it is shown. */
function describeImage(image: ImageAttachment, index: number): string {
  return `(${index + 1}) "${image.name}" ${image.width}×${image.height}`;
}

/**
 * The bracketed FACT about what the user attached, or `null` when nothing is attached. Same
 * register as `focusContextLine`: it informs the model about the message it is reading, it does not
 * issue an instruction that competes with the user's own words.
 *
 * The final sentence is load-bearing. Without it the model conflates an attached mockup with a
 * screenshot of the live page and "reads" the design as already shipped — then reports the redesign
 * as done without having touched the DOM.
 */
export function attachmentContextLine(attachments: readonly Attachment[]): string | null {
  const images = attachments.filter(isImage);
  const texts = attachments.filter(isText);
  if (images.length === 0 && texts.length === 0) return null;

  const clauses: string[] = [];
  if (images.length > 0) {
    const noun = images.length === 1 ? 'reference image' : 'reference images';
    const list = images.map(describeImage).join(', ');
    clauses.push(
      `The user attached ${images.length} ${noun} alongside this message: ${list}. ` +
        'They are reference material to design TOWARDS — they are not screenshots of the current ' +
        'page. Take a screenshot yourself if you need to see what the page looks like now.',
    );
  }
  if (texts.length > 0) {
    const noun = texts.length === 1 ? 'text attachment' : 'text attachments';
    const list = texts.map((t) => `"${t.name}"`).join(', ');
    clauses.push(
      `The user also attached ${texts.length} ${noun} (${list}), included in full below inside ` +
        '<attachment> blocks.',
    );
  }
  return `[${clauses.join(' ')}]`;
}

// --- text attachments -------------------------------------------------------------------------

/** The block fence must stay unambiguous even when the pasted text itself contains one — a paste of
 *  this very file would otherwise close the block early and the tail would read as instruction. */
const FENCE_OPEN = /<attachment\b/gi;
const FENCE_CLOSE = /<\/attachment>/gi;

function neutralizeFences(text: string): string {
  return text.replace(FENCE_CLOSE, '&lt;/attachment&gt;').replace(FENCE_OPEN, '&lt;attachment');
}

/** One named, fenced block. When the panel had to cut the paste, SAY SO right after the block —
 *  otherwise the model reasons about a tail it never saw and reports on code that isn't there. */
function renderTextAttachment(attachment: TextAttachment): string {
  const block =
    `<attachment name="${attachment.name}">\n` +
    `${neutralizeFences(attachment.text)}\n` +
    '</attachment>';
  return attachment.truncated
    ? `${block}\n[Note: "${attachment.name}" was too long to include in full — the tail was cut. ` +
        'Do not draw conclusions about the part you were not shown; ask for it if you need it.]'
    : block;
}

// --- images -----------------------------------------------------------------------------------

/** `dataUrl` is ALWAYS an inline base64 `data:` URL (the bus schema refuses `http(s)` precisely so
 *  the service worker never fetches a user-supplied origin to build a model message). Passing it
 *  straight through means no network, no decode, no failure mode. `mediaType` is stated explicitly
 *  rather than left for the provider to sniff. */
function toImagePart(attachment: ImageAttachment): UserContentPart {
  // `file` rather than the deprecated `image` part (#182) — same provider lowering, no warning.
  return { type: 'file', data: attachment.dataUrl, mediaType: attachment.mediaType };
}

/**
 * What stands in for an image in the PERSISTED thread. Written to be read cold, by a model that is
 * resuming this session and will never see the pixels: it names the file and its size so the
 * reference is still described, states plainly that it is not viewable, and tells the model the ONE
 * thing that can actually recover it — asking the user. It must never suggest capturing or fetching:
 * a mockup is a file on someone's desktop, and an agent sent looking for it screenshots the live
 * page instead and then believes that is the reference.
 */
export function imageMarker(attachment: ImageAttachment): string {
  return (
    `[reference image "${attachment.name}" (${attachment.width}×${attachment.height}) — the user ` +
    'attached it to this message and it was shown to you on that turn only. It is not viewable ' +
    'now, and you cannot capture or fetch it. Ask the user to attach it again if you need to look ' +
    'at it.]'
  );
}

// --- the mapping ------------------------------------------------------------------------------

/**
 * The turn's user-message content.
 *
 * - No attachments (`undefined` or `[]`) ⇒ `text`, unchanged, AS A STRING (header decision 1).
 * - Otherwise ⇒ `[{ type: 'text', … }, ...image parts]`: one text part carrying the grounding line,
 *   the user's (already focus-grounded, already mode-addended) instruction, and every text
 *   attachment inlined; then the images IN ATTACHMENT ORDER, because the grounding line numbers
 *   them and a reordered list would make "(2)" point at the wrong picture.
 *
 * Total: never throws, whatever the attachment list contains.
 */
export function toUserContent(
  text: string,
  attachments?: readonly Attachment[],
): string | UserContentPart[] {
  if (!attachments || attachments.length === 0) return text;

  const line = attachmentContextLine(attachments);
  if (line === null) return text;

  const blocks: string[] = [line, text];
  for (const attachment of attachments) {
    if (isText(attachment)) blocks.push(renderTextAttachment(attachment));
  }

  const parts: UserContentPart[] = [
    { type: 'text', text: blocks.filter((b) => b.length > 0).join('\n\n') },
  ];
  for (const attachment of attachments) {
    if (isImage(attachment)) parts.push(toImagePart(attachment));
  }
  return parts;
}

/**
 * The same turn's user message as the THREAD keeps it — always a plain string, and by construction
 * incapable of holding image bytes: the images become {@link imageMarker} lines, everything else is
 * the text that was going to the model anyway.
 *
 * - No attachments ⇒ byte-identical to {@link toUserContent}'s string (they return the SAME value,
 *   so the caller can compare them with `===` to take the untouched fast path).
 * - Otherwise ⇒ `instruction` + inlined text attachments + one marker per image, in attachment
 *   order, mirroring where the image parts sat in the live message.
 *
 * The forward-looking grounding line ("…design TOWARDS…, take a screenshot yourself…") is
 * deliberately NOT carried over: it describes images the reader can see, and in the thread they are
 * gone. The markers say what is true instead.
 *
 * Text attachments DO stay verbatim — they are text, they were the model's real input, and keeping
 * them is what conversation memory means for a paste. They are bounded by the bus schema
 * (`MAX_TEXT_ATTACHMENT_CHARS`), and a thread that grows past the high-water mark is already handled
 * by `thread-compact.ts` `compactSessionThread`.
 *
 * Total: never throws.
 */
export function toStoredUserContent(text: string, attachments?: readonly Attachment[]): string {
  if (!attachments || attachments.length === 0) return text;

  const blocks: string[] = [text];
  for (const attachment of attachments) {
    if (isText(attachment)) blocks.push(renderTextAttachment(attachment));
  }
  for (const attachment of attachments) {
    if (isImage(attachment)) blocks.push(imageMarker(attachment));
  }
  return blocks.filter((b) => b.length > 0).join('\n\n');
}
