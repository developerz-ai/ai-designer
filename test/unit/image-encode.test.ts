// The panel's image encoder (`sidepanel/lib/image-encode.ts`) — the half of the attachment
// pipeline that has to be right for the bus to accept anything at all.
//
// Zero browser codecs: decode/encode/base64 are injected (the shape `src/agent/vision.ts` uses for
// its capture + generate), so every number below is asserted synchronously against a fake canvas.
// The contract test is the last one in each group — the produced attachment is parsed with the
// REAL `ImageAttachment` Zod schema, which is what catches drift between this module and
// `src/shared/attachments.ts`.
import { describe, expect, it, vi } from 'vitest';
import {
  type DecodedImage,
  type EncodeDeps,
  encodeImageAttachment,
  fitsBox,
  fitWithin,
} from '@/entrypoints/sidepanel/lib/image-encode';
import {
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  ImageAttachment,
  MAX_IMAGE_DATA_URL_CHARS,
} from '@/shared/attachments';

interface EncodeCall {
  width: number;
  height: number;
  type: string;
  quality: number;
}

/** A fake codec. `bytesFor` decides how big each encode comes out, which is how the byte-cap
 *  retry ladder is driven without megabytes of real pixels. */
function deps(options: {
  width: number;
  height: number;
  /** Base64 length the encoder should pretend each attempt produced. */
  bytesFor?: (call: EncodeCall) => number;
  /** What `convertToBlob` claims it produced, per requested type. */
  producedType?: (requested: string) => string;
  /** Bytes the ORIGINAL blob base64s to (the passthrough path). */
  originalBytes?: number;
  calls?: EncodeCall[];
  closed?: { count: number };
}): EncodeDeps {
  const calls = options.calls ?? [];
  return {
    decode: async (): Promise<DecodedImage> => ({
      width: options.width,
      height: options.height,
      source: 'bitmap',
      close: () => {
        if (options.closed) options.closed.count++;
      },
    }),
    encode: async (_image, width, height, type, quality) => {
      calls.push({ width, height, type, quality });
      const produced = options.producedType ? options.producedType(type) : type;
      const size = options.bytesFor?.({ width, height, type, quality }) ?? 64;
      return new Blob(['x'.repeat(size)], { type: produced });
    },
    toBase64: async (blob) =>
      'A'.repeat(blob.type === ORIGINAL ? (options.originalBytes ?? 64) : blob.size),
  };
}

// Marker type for "this is the source blob, not something the fake canvas made".
const ORIGINAL = 'image/png';

function source(type = ORIGINAL): Blob {
  return new Blob(['original-bytes'], { type });
}

describe('fitWithin — fit inside the box, both orientations', () => {
  it('bounds a landscape image by WIDTH', () => {
    expect(fitWithin(4000, 900, 1600, 1200)).toEqual({ width: 1600, height: 360 });
  });

  // The asymmetry a naive `min(1, MAX / longestEdge)` gets wrong: it would scale this by
  // 1600/4000 and hand back 360×1600, which is 400px taller than the box it claims to fit.
  it('bounds a portrait image by HEIGHT', () => {
    expect(fitWithin(900, 4000, 1600, 1200)).toEqual({ width: 270, height: 1200 });
  });

  it('never upscales', () => {
    expect(fitWithin(400, 300, 1600, 1200)).toEqual({ width: 400, height: 300 });
    expect(fitWithin(1, 1, 1600, 1200)).toEqual({ width: 1, height: 1 });
  });

  it('leaves an image that exactly fills the box alone', () => {
    expect(fitWithin(1600, 1200, 1600, 1200)).toEqual({ width: 1600, height: 1200 });
  });

  it('preserves the aspect ratio it was given', () => {
    const { width, height } = fitWithin(3200, 2400, 1600, 1200);
    expect(width / height).toBeCloseTo(3200 / 2400, 5);
  });

  it('never rounds a dimension down to zero', () => {
    expect(fitWithin(10_000, 3, 1600, 1200).height).toBeGreaterThanOrEqual(1);
  });
});

describe('fitsBox', () => {
  it('is true only inside the box', () => {
    expect(fitsBox(1600, 1200, IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)).toBe(true);
    expect(fitsBox(1601, 1200, IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)).toBe(false);
    expect(fitsBox(1600, 1201, IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)).toBe(false);
  });
});

describe('encodeImageAttachment — passthrough', () => {
  // The headline rule: an image that already fits is NOT re-encoded. A mockup is usually a
  // lossless PNG full of 1px borders and fine text, and a pointless WebP round trip puts
  // artefacts on the one image whose job is to be matched precisely.
  it('ships the original bytes untouched when the image fits the box', async () => {
    const calls: EncodeCall[] = [];
    const result = await encodeImageAttachment(
      source(),
      { name: 'hero-v3.png' },
      deps({ width: 1200, height: 900, calls, originalBytes: 128 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The real assertion: the canvas was never touched.
    expect(calls).toEqual([]);
    expect(result.attachment.mediaType).toBe('image/png');
    expect(result.attachment.dataUrl).toBe(`data:image/png;base64,${'A'.repeat(128)}`);
    expect(result.attachment.width).toBe(1200);
    expect(result.attachment.height).toBe(900);
    expect(ImageAttachment.parse(result.attachment)).toBeTruthy();
  });

  // Independent conditions: fitting the box does not exempt an image from the byte cap.
  it('re-encodes a small image that blows the byte cap', async () => {
    const calls: EncodeCall[] = [];
    const result = await encodeImageAttachment(
      source(),
      { name: 'huge.png' },
      deps({
        width: 1200,
        height: 900,
        calls,
        originalBytes: MAX_IMAGE_DATA_URL_CHARS + 1,
        bytesFor: () => 500,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls.length).toBeGreaterThan(0);
    expect(result.attachment.mediaType).toBe('image/webp');
    expect(result.attachment.dataUrl.length).toBeLessThanOrEqual(MAX_IMAGE_DATA_URL_CHARS);
    // Not resized — it already fitted; only re-encoded.
    expect(result.attachment.width).toBe(1200);
    expect(ImageAttachment.parse(result.attachment)).toBeTruthy();
  });

  it('converts a small image of an unsupported type', async () => {
    const result = await encodeImageAttachment(
      source('image/bmp'),
      { name: 'old.bmp' },
      deps({ width: 200, height: 100 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.mediaType).toBe('image/webp');
    expect(ImageAttachment.parse(result.attachment)).toBeTruthy();
  });
});

describe('encodeImageAttachment — resize + re-encode', () => {
  it('downscales past the box and reports the POST-downscale size', async () => {
    const calls: EncodeCall[] = [];
    const result = await encodeImageAttachment(
      source(),
      { name: 'banner.png' },
      deps({ width: 4000, height: 900, calls }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls[0]).toMatchObject({ width: 1600, height: 360, type: 'image/webp' });
    expect(result.attachment.width).toBe(1600);
    expect(result.attachment.height).toBe(360);
    expect(ImageAttachment.parse(result.attachment)).toBeTruthy();
  });

  it('downscales a portrait screenshot by its height', async () => {
    const calls: EncodeCall[] = [];
    await encodeImageAttachment(
      source(),
      { name: 'mobile.png' },
      deps({ width: 900, height: 4000, calls }),
    );

    expect(calls[0]).toMatchObject({ width: 270, height: 1200 });
  });

  it('falls back to the next format when the canvas returns an unusable type', async () => {
    const calls: EncodeCall[] = [];
    const result = await encodeImageAttachment(
      source(),
      { name: 'x.png' },
      deps({
        width: 3000,
        height: 2000,
        calls,
        // An environment with no WebP encoder that reports the truth in `blob.type`.
        producedType: (requested) =>
          requested === 'image/webp' ? 'application/octet-stream' : requested,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls.map((c) => c.type)).toEqual(['image/webp', 'image/jpeg']);
    expect(result.attachment.mediaType).toBe('image/jpeg');
    expect(ImageAttachment.parse(result.attachment)).toBeTruthy();
  });

  it('retries at progressively lower quality while over the byte cap', async () => {
    const calls: EncodeCall[] = [];
    const result = await encodeImageAttachment(
      source(),
      { name: 'big.png' },
      deps({
        width: 4000,
        height: 3000,
        calls,
        // Only the third attempt (lower quality AND a smaller box) comes in under the cap.
        bytesFor: (call) => (call.quality <= 0.5 ? 1000 : MAX_IMAGE_DATA_URL_CHARS + 1),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const qualities = calls.map((c) => c.quality);
    expect(qualities[0]).toBeGreaterThan(qualities[qualities.length - 1] ?? 1);
    expect(result.attachment.dataUrl.length).toBeLessThanOrEqual(MAX_IMAGE_DATA_URL_CHARS);
    expect(ImageAttachment.parse(result.attachment)).toBeTruthy();
  });

  it('gives up with a typed failure after a BOUNDED number of attempts', async () => {
    const calls: EncodeCall[] = [];
    const result = await encodeImageAttachment(
      source(),
      { name: 'impossible.png' },
      deps({ width: 4000, height: 3000, calls, bytesFor: () => MAX_IMAGE_DATA_URL_CHARS + 1 }),
    );

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    // Four ladder rungs, one format each — never an unbounded loop.
    expect(calls.length).toBeLessThanOrEqual(8);
  });
});

describe('encodeImageAttachment — failures never throw', () => {
  it('returns a decode failure for something that is not an image', async () => {
    const broken: EncodeDeps = {
      ...deps({ width: 10, height: 10 }),
      decode: async () => {
        throw new Error('not an image');
      },
    };

    await expect(
      encodeImageAttachment(
        new Blob(['nope'], { type: 'application/pdf' }),
        { name: 'a.pdf' },
        broken,
      ),
    ).resolves.toEqual({ ok: false, reason: 'decode' });
  });

  it('returns an encode failure when no format works', async () => {
    const result = await encodeImageAttachment(
      source('image/bmp'),
      { name: 'x.bmp' },
      deps({ width: 10, height: 10, producedType: () => 'application/octet-stream' }),
    );

    expect(result).toEqual({ ok: false, reason: 'encode' });
  });

  it('closes the decoded bitmap on every path — a leak holds the full decoded surface', async () => {
    const closed = { count: 0 };
    await encodeImageAttachment(
      source(),
      { name: 'a.png' },
      deps({ width: 4000, height: 3000, closed }),
    );
    await encodeImageAttachment(
      source(),
      { name: 'b.png' },
      deps({ width: 100, height: 100, closed }),
    );

    expect(closed.count).toBe(2);
  });

  it('never emits an attachment the shared schema would reject', async () => {
    const result = await encodeImageAttachment(
      source(),
      { name: '  '.repeat(200) },
      deps({ width: 4000, height: 3000 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A blank name would fail `min(1)`; the module substitutes a label rather than shipping it.
    expect(() => ImageAttachment.parse(result.attachment)).not.toThrow();
  });
});

describe('encodeImageAttachment — id', () => {
  it('adopts a caller-supplied id so the tray key survives the round trip', async () => {
    const result = await encodeImageAttachment(
      source(),
      { name: 'a.png', id: 'fixed-id' },
      deps({ width: 100, height: 100 }),
    );

    expect(result.ok && result.attachment.id).toBe('fixed-id');
  });

  it('mints one otherwise', async () => {
    const spy = vi.spyOn(crypto, 'randomUUID');
    await encodeImageAttachment(source(), { name: 'a.png' }, deps({ width: 100, height: 100 }));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
