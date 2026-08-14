// Turn a picked/pasted/dropped image file into an `ImageAttachment` the bus will accept.
//
// Panel-side on purpose (CLAUDE.md "three worlds"): this needs a codec and a canvas, the service
// worker has neither, and the content script must never see anything the user attached. It is also
// the DOWNSCALE that makes the caps in `src/shared/attachments.ts` reachable — a 12MP phone
// screenshot is ~8MB of base64 and would be refused at the bus boundary; at 1536px it is a few
// hundred KB and the model sees exactly as much detail.
//
// No business logic in components (CLAUDE.md "SolidJS + SRP"), so none of this lives in Composer.
// Injected deps mirror `src/agent/vision.ts`: the decode, the canvas re-encode and the base64 read
// are all parameters, so the unit test runs without a real browser codec.

import {
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  type ImageAttachment,
  isSupportedImageType,
  MAX_IMAGE_DATA_URL_CHARS,
} from '@/shared/attachments';

/** A decoded bitmap: its intrinsic size, plus the drawable itself. `source` is deliberately opaque
 *  — the real dep hands back an `ImageBitmap`, a test hands back whatever its fake canvas
 *  understands, and nothing in between needs to know which. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly source: unknown;
  /** Frees the bitmap's memory. Optional so a fake need not implement it. */
  close?(): void;
}

/** Bytes -> decoded bitmap. Throws on a corrupt/undecodable file; the caller turns that into a
 *  typed failure. */
export type DecodeImage = (blob: Blob) => Promise<DecodedImage>;

/** Draw a decoded bitmap at `width`×`height` and re-encode it. The returned blob's `type` is the
 *  format the environment ACTUALLY produced — `OffscreenCanvas.convertToBlob` silently falls back
 *  to PNG for a type it cannot encode and only says so there, so callers must read it back rather
 *  than assume they got what they asked for. */
export type EncodeBitmap = (
  image: DecodedImage,
  width: number,
  height: number,
  type: string,
  quality: number,
) => Promise<Blob>;

/** Blob -> the base64 PAYLOAD only (no `data:` prefix). The prefix is rebuilt from the media type
 *  this module resolved, so the string can never claim a type the blob does not have — which is
 *  exactly what `ImageAttachment`'s refine checks. */
export type ReadBase64 = (blob: Blob) => Promise<string>;

export interface EncodeDeps {
  readonly decode: DecodeImage;
  readonly encode: EncodeBitmap;
  readonly toBase64: ReadBase64;
}

/** Why an encode produced no attachment. Codes, not sentences: the copy lives in
 *  `stores/attachments.ts` behind `#i18n` (CLAUDE.md — no hardcoded UI strings).
 *
 *  There is no `unsupported` here: an image of a type the SCHEMA does not accept is CONVERTED
 *  rather than refused (a small BMP becomes a WebP). Refusing a file by its declared type is a
 *  policy decision, and it belongs at the door — `stores/attachments.ts` and the file input's
 *  `accept` list — not in the encoder. What cannot be decoded at all fails as `decode`. */
export type EncodeFailureReason = 'decode' | 'encode' | 'too-large';

export type EncodeImageResult =
  | { readonly ok: true; readonly attachment: ImageAttachment }
  | { readonly ok: false; readonly reason: EncodeFailureReason };

/** Output formats, in preference order. WebP first — it is 25-35% smaller than JPEG at the same
 *  perceptual quality and every model that reads images reads it. JPEG and PNG are the fallbacks
 *  for an environment whose canvas cannot encode WebP.
 *
 *  An ANIMATED GIF re-encoded here loses its animation, and that is correct, not a bug to fix: a
 *  vision model is shown one frame whatever the container, so shipping the other 200 frames would
 *  cost the user tokens for pixels nothing looks at. */
const OUTPUT_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;

/** Bounded retry ladder. Each attempt is cheaper than the last — quality first (invisible at these
 *  sizes), then scale, because PNG ignores `quality` entirely and a PNG-only environment would
 *  otherwise re-encode the identical bytes four times and still be over the cap. */
const ATTEMPTS = [
  { quality: 0.82, scale: 1 },
  { quality: 0.62, scale: 1 },
  { quality: 0.5, scale: 0.75 },
  { quality: 0.4, scale: 0.5 },
] as const;

/**
 * Fit INSIDE a box, aspect ratio preserved — the contract `src/shared/attachments.ts` states, and
 * deliberately not a longest-edge cap: bounding only the longest edge leaves the other dimension
 * unbounded, so a 900×4000 mobile screenshot would pass a 1600 "max edge" test at 360×1600 and
 * still be taller than the box. Scale is `min(1, maxW/w, maxH/h)`; the leading 1 is what makes it
 * never upscale, so a 400×300 logo stays 400×300 rather than being stretched to a blurred
 * sixteen-times-larger payload.
 *
 * Fit, not fill and not crop: nothing an attachment shows may be cut off — the whole reason it is
 * attached is that the user wants the agent to look at ALL of it.
 *
 * Pure — unit-tested in both orientations without a canvas.
 */
export function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width, height };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  if (scale >= 1) return { width, height };
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Fallback label for a blob that arrived without a file name (a clipboard paste often does). The
 *  store normally supplies a real, numbered name; this only keeps the schema's `min(1)` honest. */
const UNNAMED = 'image';

/** Whether an image needs no resizing at all. Pure, and separate from the passthrough DECISION
 *  because fitting the box is only one of that decision's three conditions. */
export function fitsBox(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): boolean {
  return width > 0 && height > 0 && width <= maxWidth && height <= maxHeight;
}

/**
 * Encode one image file into an {@link ImageAttachment}.
 *
 * Two paths, and the first one matters more than it looks:
 *
 *  1. **Passthrough** — the source already fits inside {@link IMAGE_MAX_WIDTH}×{@link
 *     IMAGE_MAX_HEIGHT}, its type is one the schema accepts, AND its base64 fits
 *     {@link MAX_IMAGE_DATA_URL_CHARS}. Then the ORIGINAL BYTES ship, untouched — no canvas, no
 *     re-encode. A mockup is very often a lossless PNG full of fine text and 1px borders, and
 *     round-tripping that through lossy WebP to save nothing produces exactly the artefacts a
 *     designer notices, on the one image whose whole job is to be matched precisely.
 *  2. **Resize/re-encode** — everything else: fit inside the box, aspect preserved, never
 *     upscaled, retrying at lower quality/scale while the result is over the byte cap.
 *
 * The three passthrough conditions are independent and all required. A 1200×900 lossless PNG can
 * blow the byte cap while fitting the box comfortably (that is the condition that actually bites);
 * a small AVIF has to be converted whatever its size, because the bus accepts only png/jpeg/webp/gif.
 *
 * NEVER throws and never returns an attachment the bus schema would reject: every failure path is
 * a typed `{ ok: false, reason }` the store turns into a visible sentence.
 */
export async function encodeImageAttachment(
  blob: Blob,
  options: { readonly name: string; readonly id?: string },
  deps: EncodeDeps = defaultEncodeDeps(),
): Promise<EncodeImageResult> {
  let image: DecodedImage;
  try {
    // Also how the intrinsic dimensions are read — and the bitmap is closed in the `finally`
    // below, because a leaked `ImageBitmap` holds its entire decoded surface.
    image = await deps.decode(blob);
  } catch {
    return { ok: false, reason: 'decode' };
  }

  try {
    if (
      isSupportedImageType(blob.type) &&
      fitsBox(image.width, image.height, IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)
    ) {
      const original = await toDataUrl(deps, blob, blob.type);
      if (original && original.length <= MAX_IMAGE_DATA_URL_CHARS) {
        return {
          ok: true,
          attachment: attachmentFrom(options, blob.type, original, image.width, image.height),
        };
      }
      // Over the byte cap despite fitting the box — fall through and re-encode it smaller.
    }

    for (const attempt of ATTEMPTS) {
      const size = fitWithin(
        image.width,
        image.height,
        Math.round(IMAGE_MAX_WIDTH * attempt.scale),
        Math.round(IMAGE_MAX_HEIGHT * attempt.scale),
      );
      const encoded = await encodeOnce(deps, image, size, attempt.quality);
      if (!encoded) return { ok: false, reason: 'encode' };

      const dataUrl = await toDataUrl(deps, encoded.blob, encoded.mediaType);
      if (!dataUrl) return { ok: false, reason: 'encode' };
      if (dataUrl.length <= MAX_IMAGE_DATA_URL_CHARS) {
        return {
          ok: true,
          attachment: attachmentFrom(options, encoded.mediaType, dataUrl, size.width, size.height),
        };
      }
    }
    return { ok: false, reason: 'too-large' };
  } finally {
    image.close?.();
  }
}

/** Base64 a blob and label it with the media type this module RESOLVED, never with the prefix the
 *  reader produced: a blob with an empty `type` reads back as `data:;base64,…`, which is not a
 *  legal `ImageAttachment`. Returns `''` when the read failed. */
async function toDataUrl(deps: EncodeDeps, blob: Blob, mediaType: string): Promise<string> {
  let payload: string;
  try {
    payload = await deps.toBase64(blob);
  } catch {
    return '';
  }
  return payload ? `data:${mediaType};base64,${payload}` : '';
}

function attachmentFrom(
  options: { readonly name: string; readonly id?: string },
  mediaType: ImageAttachment['mediaType'],
  dataUrl: string,
  width: number,
  height: number,
): ImageAttachment {
  return {
    kind: 'image',
    id: options.id ?? crypto.randomUUID(),
    name: options.name.trim().slice(0, 200) || UNNAMED,
    mediaType,
    dataUrl,
    width,
    height,
  };
}

/** One encode pass: try each output format until the canvas returns a blob whose OWN type is one
 *  the schema accepts. Returns null when nothing usable came back. */
async function encodeOnce(
  deps: EncodeDeps,
  image: DecodedImage,
  size: { width: number; height: number },
  quality: number,
): Promise<{ mediaType: ImageAttachment['mediaType']; blob: Blob } | null> {
  for (const type of OUTPUT_TYPES) {
    let out: Blob;
    try {
      out = await deps.encode(image, size.width, size.height, type, quality);
    } catch {
      continue;
    }
    const mediaType = out.type;
    if (isSupportedImageType(mediaType)) return { mediaType, blob: out };
  }
  return null;
}

/** The real browser deps. Split out so `encodeImageAttachment` stays chrome-free and testable. */
export function defaultEncodeDeps(): EncodeDeps {
  return {
    decode: async (blob) => {
      const bitmap = await createImageBitmap(blob);
      return {
        width: bitmap.width,
        height: bitmap.height,
        source: bitmap,
        close: () => bitmap.close(),
      };
    },
    encode: async (image, width, height, type, quality) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(image.source as CanvasImageSource, 0, 0, width, height);
      return canvas.convertToBlob({ type, quality });
    },
    toBase64: readBase64,
  };
}

/** `FileReader` is available here — the side panel is a real document with its own origin. (The
 *  service worker is not, which is why `background.ts` hand-rolls a base64 encoder instead.)
 *  Chunk-free by construction: the reader does the work, so nothing ever spreads a multi-megabyte
 *  array into `String.fromCharCode`. */
function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma === -1 ? '' : result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}
