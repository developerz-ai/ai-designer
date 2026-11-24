// The draft's attachment list (`sidepanel/stores/attachments.ts`) — every rule about what may be
// attached, asserted against the SHARED caps rather than against numbers copied into this file.
//
// The encoder is mocked: what is under test here is the list, not the codec (that is
// `image-encode.test.ts`). Failure cases first — a refused attachment that says nothing is
// indistinguishable from a broken feature, and that is the defect worth guarding.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncodeImageResult } from '@/entrypoints/sidepanel/lib/image-encode';
import {
  addBigPaste,
  addFiles,
  attachmentError,
  attachments,
  capacityDenial,
  clearAttachments,
  isBigPaste,
  makeTextAttachment,
  removeAttachment,
} from '@/entrypoints/sidepanel/stores/attachments';
import {
  Attachments,
  BIG_PASTE_THRESHOLD_CHARS,
  MAX_ATTACHMENTS,
  MAX_IMAGE_ATTACHMENTS,
  MAX_TEXT_ATTACHMENT_CHARS,
  MAX_TEXT_ATTACHMENTS,
} from '@/shared/attachments';

const encode = vi.hoisted(() =>
  vi.fn(
    async (_blob: Blob, options: { name: string; id?: string }): Promise<EncodeImageResult> => ({
      ok: true,
      attachment: {
        kind: 'image',
        id: options.id ?? crypto.randomUUID(),
        name: options.name,
        mediaType: 'image/webp',
        dataUrl: 'data:image/webp;base64,AAAA',
        width: 800,
        height: 600,
      },
    }),
  ),
);

vi.mock('@/entrypoints/sidepanel/lib/image-encode-client', () => ({
  queueImageEncode: encode,
}));

function png(name = 'mockup.png'): File {
  return new File(['bytes'], name, { type: 'image/png' });
}

beforeEach(() => {
  clearAttachments();
  encode.mockClear();
});

describe('capacityDenial', () => {
  const image = { kind: 'image' as const };
  const text = { kind: 'text' as const };
  const list = (images: number, texts: number) =>
    [
      ...Array.from({ length: images }, () => image),
      ...Array.from({ length: texts }, () => text),
    ] as never;

  it('refuses a 7th image', () => {
    expect(capacityDenial(list(MAX_IMAGE_ATTACHMENTS - 1, 0), 'image')).toBeNull();
    expect(capacityDenial(list(MAX_IMAGE_ATTACHMENTS, 0), 'image')).toBe('image-cap');
  });

  it('refuses a 5th text', () => {
    expect(capacityDenial(list(0, MAX_TEXT_ATTACHMENTS - 1), 'text')).toBeNull();
    expect(capacityDenial(list(0, MAX_TEXT_ATTACHMENTS), 'text')).toBe('text-cap');
  });

  it('refuses anything once the combined cap is reached, whatever the mix', () => {
    expect(capacityDenial(list(MAX_IMAGE_ATTACHMENTS, 2), 'text')).toBe('total-cap');
    expect(capacityDenial(list(4, 4), 'image')).toBe('total-cap');
    expect(MAX_ATTACHMENTS).toBe(8);
  });

  // Without the reservation, dropping ten files passes ten capacity checks before the first
  // encode finishes and the tray sails past the cap.
  it('counts encodes still in flight', () => {
    expect(capacityDenial(list(2, 0), 'image', 4)).toBe('image-cap');
    expect(capacityDenial(list(0, 0), 'image', MAX_ATTACHMENTS)).toBe('total-cap');
  });
});

describe('isBigPaste', () => {
  it('promotes only what would flood the field', () => {
    expect(isBigPaste('x'.repeat(BIG_PASTE_THRESHOLD_CHARS))).toBe(false);
    expect(isBigPaste('x'.repeat(BIG_PASTE_THRESHOLD_CHARS + 1))).toBe(true);
  });
});

describe('makeTextAttachment', () => {
  it('keeps a normal paste whole and unflagged', () => {
    const a = makeTextAttachment('body { color: red }', 'Pasted text 1', 'id-1');
    expect(a).toEqual({
      kind: 'text',
      id: 'id-1',
      name: 'Pasted text 1',
      text: 'body { color: red }',
      truncated: false,
    });
  });

  it('cuts at the shared ceiling and SAYS so', () => {
    const a = makeTextAttachment('x'.repeat(MAX_TEXT_ATTACHMENT_CHARS + 500), 'Pasted text 1');
    expect(a.text).toHaveLength(MAX_TEXT_ATTACHMENT_CHARS);
    expect(a.truncated).toBe(true);
  });
});

describe('addBigPaste', () => {
  it('promotes a paste into a named attachment the bus schema accepts', () => {
    addBigPaste('x'.repeat(BIG_PASTE_THRESHOLD_CHARS + 1));

    expect(attachments()).toHaveLength(1);
    expect(attachments()[0]?.name).toBe('Pasted text 1');
    expect(() => Attachments.parse(attachments())).not.toThrow();
  });

  it('numbers pastes so two of them are tellable apart', () => {
    addBigPaste('one');
    addBigPaste('two');
    expect(attachments().map((a) => a.name)).toEqual(['Pasted text 1', 'Pasted text 2']);
  });

  it('refuses past the text cap with a visible reason, not silently', () => {
    for (let i = 0; i < MAX_TEXT_ATTACHMENTS; i++) addBigPaste(`paste ${i}`);
    expect(attachmentError()).toBeNull();

    expect(addBigPaste('one too many')).toBeNull();
    expect(attachments()).toHaveLength(MAX_TEXT_ATTACHMENTS);
    expect(attachmentError()).toContain(String(MAX_TEXT_ATTACHMENTS));
  });
});

describe('addFiles', () => {
  it('encodes and appends an image', async () => {
    await addFiles([png('hero-v3.png')]);

    expect(attachments()).toHaveLength(1);
    expect(attachments()[0]?.name).toBe('hero-v3.png');
    expect(() => Attachments.parse(attachments())).not.toThrow();
  });

  it('refuses a non-image by name, and keeps going for the rest', async () => {
    await addFiles([new File(['x'], 'spec.pdf', { type: 'application/pdf' }), png('ok.png')]);

    expect(attachments()).toHaveLength(1);
    expect(attachmentError()).toContain('spec.pdf');
  });

  // The cap case the brief calls out: the 7th image is REFUSED WITH A REASON.
  it('refuses the 7th image and says which cap it hit', async () => {
    await addFiles(Array.from({ length: MAX_IMAGE_ATTACHMENTS }, (_, i) => png(`m${i}.png`)));
    expect(attachments()).toHaveLength(MAX_IMAGE_ATTACHMENTS);
    expect(attachmentError()).toBeNull();

    await addFiles([png('seventh.png')]);

    expect(attachments()).toHaveLength(MAX_IMAGE_ATTACHMENTS);
    expect(attachmentError()).toContain(String(MAX_IMAGE_ATTACHMENTS));
    expect(encode).toHaveBeenCalledTimes(MAX_IMAGE_ATTACHMENTS);
  });

  it('holds the cap when a whole burst arrives at once', async () => {
    await addFiles(Array.from({ length: 12 }, (_, i) => png(`m${i}.png`)));

    expect(attachments()).toHaveLength(MAX_IMAGE_ATTACHMENTS);
    expect(() => Attachments.parse(attachments())).not.toThrow();
  });

  it('surfaces an encode failure instead of dropping the file in silence', async () => {
    encode.mockResolvedValueOnce({ ok: false, reason: 'too-large' });

    await addFiles([png('enormous.png')]);

    expect(attachments()).toHaveLength(0);
    expect(attachmentError()).toContain('enormous.png');
  });

  it('never leaves the tray spinning when the encoder throws', async () => {
    encode.mockRejectedValueOnce(new Error('worker exploded'));

    await addFiles([png('a.png')]);

    expect(attachments()).toHaveLength(0);
    expect(attachmentError()).toBeTruthy();
  });
});

describe('removeAttachment / clearAttachments', () => {
  it('removes exactly the one asked for', async () => {
    await addFiles([png('a.png'), png('b.png'), png('c.png')]);
    const target = attachments()[1];

    removeAttachment(target?.id ?? '');

    expect(attachments().map((a) => a.name)).toEqual(['a.png', 'c.png']);
  });

  it('is a no-op for an id that is not there', async () => {
    await addFiles([png('a.png')]);
    removeAttachment('nope');
    expect(attachments()).toHaveLength(1);
  });

  it('clears the list, the error and the per-draft numbering', () => {
    addBigPaste('one');
    addBigPaste('two');
    clearAttachments();
    addBigPaste('three');

    expect(attachments().map((a) => a.name)).toEqual(['Pasted text 1']);
    expect(attachmentError()).toBeNull();
  });
});
