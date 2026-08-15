import { describe, expect, it } from 'vitest';
import { imageFilePart } from '@/agent/image-part';

// The one producer of image `file` parts (#182 — the `{type:'image'}` deprecation sweep). What has
// to hold: the mediaType is read off the data URL itself so a JPEG band never ships labelled PNG,
// and a bare payload still gets a truthful default instead of an absent mediaType the provider
// would have to sniff.

describe('imageFilePart', () => {
  it('reads the mediaType off the data URL', () => {
    const part = imageFilePart('data:image/webp;base64,AAAA');
    expect(part).toEqual({
      type: 'file',
      data: 'data:image/webp;base64,AAAA',
      mediaType: 'image/webp',
    });
  });

  it('handles a data URL without base64 marker (comma-delimited)', () => {
    expect(imageFilePart('data:image/svg+xml,<svg/>').mediaType).toBe('image/svg+xml');
  });

  it('falls back to PNG — the only format the extension captures — for a bare payload', () => {
    expect(imageFilePart('AAAA').mediaType).toBe('image/png');
  });

  it('honours an explicit fallback', () => {
    expect(imageFilePart('AAAA', 'image/jpeg').mediaType).toBe('image/jpeg');
  });
});
