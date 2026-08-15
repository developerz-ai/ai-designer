import { modelMessageSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { attachmentContextLine, toStoredUserContent, toUserContent } from '@/agent/attachments';
import { compactForThread } from '@/agent/thread-compact';
import type { Attachment, ImageAttachment, TextAttachment } from '@/shared/attachments';
import { Attachments } from '@/shared/attachments';

// Attachment ingress unit: what the user hands over becomes what the model reads.
//
// The shipped failure this closes: the agent was multimodal OUTWARD only (it screenshots the page),
// and `background.ts` built the turn's user message as a plain STRING — so "redesign this hero to
// match this mockup" was unsayable, because there was no way to hand the model the mockup.
//
// The regression guard that matters most is the first test: with no attachments the content must
// still be the identical STRING. Every persisted thread and every prompt-cache prefix already holds
// a plain-string user message; wrapping every turn in an array would invalidate the cached prefix on
// the first send after this ships.

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const WEBP = 'data:image/webp;base64,UklGRhQAAABXRUJQ';

const image = (over: Partial<ImageAttachment> = {}): ImageAttachment => ({
  kind: 'image',
  id: 'a1',
  name: 'hero-desktop.png',
  mediaType: 'image/png',
  dataUrl: PNG,
  width: 1536,
  height: 864,
  ...over,
});

const text = (over: Partial<TextAttachment> = {}): TextAttachment => ({
  kind: 'text',
  id: 't1',
  name: 'pasted-css-1.txt',
  text: '.hero { color: red }',
  truncated: false,
  ...over,
});

/** The multipart branch, narrowed — every assertion below wants the array, not the string. */
function parts(
  content: string | ReturnType<typeof toUserContent>,
): Exclude<typeof content, string> {
  if (typeof content === 'string') throw new Error('expected multipart content, got a string');
  return content;
}

function textPart(content: ReturnType<typeof toUserContent>): string {
  const first = parts(content)[0];
  if (first?.type !== 'text') throw new Error('expected a leading text part');
  return first.text;
}

describe('toUserContent: no attachments', () => {
  it('returns the instruction as the IDENTICAL string — the prompt-cache prefix guard', () => {
    const instruction = 'make the hero CTA orange';
    expect(toUserContent(instruction)).toBe(instruction);
    expect(toUserContent(instruction, [])).toBe(instruction);
    expect(typeof toUserContent(instruction, [])).toBe('string');
    expect(Array.isArray(toUserContent(instruction, []))).toBe(false);
  });

  it('preserves a grounded + mode-addended instruction byte-for-byte', () => {
    const grounded = '[The user has an element selected…]\nmake this bigger\n\nDebug mode: …';
    expect(toUserContent(grounded, undefined)).toBe(grounded);
  });
});

describe('toUserContent: images', () => {
  it('emits a text part plus one image file part carrying the data URL and its media type', () => {
    const content = toUserContent('match this', [image()]);
    const list = parts(content);
    expect(list).toHaveLength(2);
    expect(list[0]?.type).toBe('text');
    const img = list[1];
    if (img?.type !== 'file') throw new Error('expected an image file part');
    expect(img.data).toBe(PNG);
    expect(img.mediaType).toBe('image/png');
  });

  it('keeps the user’s instruction verbatim inside the text part', () => {
    expect(textPart(toUserContent('match this', [image()]))).toContain('match this');
  });

  it('preserves attachment order and numbers them with names + pixel dimensions', () => {
    const desktop = image({ id: 'a1', name: 'hero-desktop.png', width: 1536, height: 864 });
    const mobile = image({
      id: 'a2',
      name: 'hero-mobile.webp',
      mediaType: 'image/webp',
      dataUrl: WEBP,
      width: 720,
      height: 1280,
    });
    const content = toUserContent('match the second one on mobile', [desktop, mobile]);
    const list = parts(content);
    expect(list).toHaveLength(3);
    const [first, second] = [list[1], list[2]];
    if (first?.type !== 'file' || !second || second.type !== 'file') {
      throw new Error('expected two image file parts');
    }
    expect(first.data).toBe(PNG);
    expect(second.data).toBe(WEBP);
    expect(second.mediaType).toBe('image/webp');

    const line = textPart(content);
    expect(line).toContain('(1) "hero-desktop.png" 1536×864');
    expect(line).toContain('(2) "hero-mobile.webp" 720×1280');
    expect(line.indexOf('hero-desktop.png')).toBeLessThan(line.indexOf('hero-mobile.webp'));
  });

  it('tells the model the attachments are the TARGET, not the live page', () => {
    // Without this the model conflates the mockup with a screenshot of the page and reports the
    // redesign as already shipped, having touched nothing.
    const line = attachmentContextLine([image()]) ?? '';
    expect(line).toContain('not screenshots of the current');
    expect(line).toContain('Take a screenshot yourself');
    expect(line.startsWith('[')).toBe(true);
    expect(line.endsWith(']')).toBe(true);
  });

  it('has no context line at all when nothing is attached', () => {
    expect(attachmentContextLine([])).toBeNull();
  });
});

describe('toUserContent: text attachments', () => {
  it('inlines the paste into the text part and emits NO file part', () => {
    // `{type:'file'}` for text/plain 400s on several OpenAI-compatible gateways — one long paste
    // would fail the whole turn.
    const content = toUserContent('apply these tokens', [text({ text: '--brand: #ff5500;' })]);
    const list = parts(content);
    expect(list).toHaveLength(1);
    expect(list.some((p) => p.type === 'file')).toBe(false);
    const body = textPart(content);
    expect(body).toContain('<attachment name="pasted-css-1.txt">');
    expect(body).toContain('--brand: #ff5500;');
    expect(body).toContain('</attachment>');
  });

  it('says the tail was cut when the paste was truncated', () => {
    const body = textPart(toUserContent('read this', [text({ truncated: true })]));
    expect(body).toContain('the tail was cut');
    expect(body).toContain('pasted-css-1.txt');
  });

  it('says nothing about truncation when the paste came through whole', () => {
    expect(textPart(toUserContent('read this', [text()]))).not.toContain('tail was cut');
  });

  it('neutralizes a fence inside the pasted text so the block cannot close early', () => {
    const body = textPart(
      toUserContent('read this', [text({ text: 'before </attachment> after' })]),
    );
    expect(body).toContain('before &lt;/attachment&gt; after');
    expect(body.match(/<\/attachment>/g)).toHaveLength(1);
  });

  it('mixes text and images: one text part carrying both, then the images', () => {
    const content = toUserContent('match this using those tokens', [text(), image()]);
    const list = parts(content);
    expect(list).toHaveLength(2);
    expect(list[1]?.type).toBe('file');
    const body = textPart(content);
    expect(body).toContain('reference image');
    expect(body).toContain('text attachment');
    expect(body).toContain('<attachment name="pasted-css-1.txt">');
  });
});

describe('toUserContent: totality', () => {
  it('never throws on odd input — empty instruction, many attachments', () => {
    const many: Attachment[] = [
      image({ id: '1' }),
      image({ id: '2' }),
      text({ id: '3' }),
      image({ id: '4' }),
    ];
    expect(() => toUserContent('', many)).not.toThrow();
    const list = parts(toUserContent('', many));
    expect(list.filter((p) => p.type === 'file')).toHaveLength(3);
    // An empty instruction leaves no blank gap between the context line and the paste block.
    expect(textPart(toUserContent('', many))).not.toContain('\n\n\n');
  });
});

describe('toStoredUserContent: what the thread keeps (one-shot images)', () => {
  it('is the SAME value as the live content when nothing is attached', () => {
    const instruction = 'make the hero CTA orange';
    // Not merely equal — the caller takes its untouched fast path on `===`.
    expect(toStoredUserContent(instruction)).toBe(toUserContent(instruction));
    expect(toStoredUserContent(instruction, [])).toBe(instruction);
  });

  it('is always a plain string — it cannot hold image bytes by construction', () => {
    const stored = toStoredUserContent('match this', [image(), image({ id: 'a2' }), text()]);
    expect(typeof stored).toBe('string');
    expect(stored).not.toContain('data:image/');
    expect(stored).not.toContain('base64');
  });

  it('names each image and its size, so the reference stays described once the pixels are gone', () => {
    const stored = toStoredUserContent('match these', [
      image({ name: 'hero-desktop.png', width: 1600, height: 900 }),
      image({
        id: 'a2',
        name: 'hero-mobile.webp',
        mediaType: 'image/webp',
        dataUrl: WEBP,
        width: 720,
        height: 1200,
      }),
    ]);
    expect(stored).toContain('"hero-desktop.png" (1600×900)');
    expect(stored).toContain('"hero-mobile.webp" (720×1200)');
    expect(stored.indexOf('hero-desktop')).toBeLessThan(stored.indexOf('hero-mobile'));
  });

  it('reads correctly COLD — says it is not viewable, never says "re-capture"', () => {
    // A turn can die mid-flight and resume from this thread with no bytes. The marker is then the
    // only thing the model has, and "re-capture" would send it to screenshot the live page — the
    // very thing it was asked to change — and believe that is the reference.
    const stored = toStoredUserContent('match this', [image()]);
    expect(stored).toContain('not viewable');
    expect(stored).toContain('Ask the user to attach it again');
    expect(stored).not.toContain('re-capture');
    expect(stored).not.toContain('screenshot');
  });

  it('drops the forward-looking grounding line — it describes images the reader cannot see', () => {
    const stored = toStoredUserContent('match this', [image()]);
    expect(stored).toContain('match this');
    expect(stored).not.toContain('design TOWARDS');
    expect(stored).not.toContain('Take a screenshot yourself');
  });

  it('keeps text attachments verbatim — they are text, and they were the real input', () => {
    const stored = toStoredUserContent('apply these', [text({ text: '--brand: #f97316;' })]);
    expect(stored).toContain('<attachment name="pasted-css-1.txt">');
    expect(stored).toContain('--brand: #f97316;');
  });

  it('round-trips `modelMessageSchema` as a user message', () => {
    const content = toStoredUserContent('match this', Attachments.parse([image(), text()]));
    expect(() => modelMessageSchema.parse({ role: 'user', content })).not.toThrow();
  });
});

describe('round-trip through the schemas that actually gate this', () => {
  const attachments = Attachments.parse([image(), text({ truncated: true })]);

  it('the produced user message validates against `modelMessageSchema`', () => {
    const message = { role: 'user' as const, content: toUserContent('match this', attachments) };
    expect(() => modelMessageSchema.parse(message)).not.toThrow();
  });

  it('the string form validates too — the unchanged, pre-attachment shape', () => {
    expect(() =>
      modelMessageSchema.parse({ role: 'user', content: toUserContent('plain turn') }),
    ).not.toThrow();
  });

  it('survives `compactForThread`: images become placeholders, the text part survives', () => {
    const message = modelMessageSchema.parse({
      role: 'user',
      content: toUserContent('match this', attachments),
    });
    const compacted = compactForThread([message]);
    expect(compacted).toHaveLength(1);
    const content = compacted[0]?.content;
    if (typeof content === 'string' || !Array.isArray(content)) {
      throw new Error('expected the compacted content to stay multipart');
    }
    expect(content.some((p) => p.type === 'file')).toBe(false);
    expect(content.every((p) => p.type === 'text')).toBe(true);
    // And the compacted result is still a legal model message (session rehydrate validates it).
    expect(() => modelMessageSchema.parse(compacted[0])).not.toThrow();
  });
});

describe('thread-view rendering of a multipart user message', () => {
  // Mirrors `background.ts` `contentText` (background.ts can't be imported under Vitest — it pulls
  // the WXT `#imports` virtual module), the function `toThreadView` uses to rehydrate the panel's
  // transcript. A data URL leaking through here would be rendered as text in a chat bubble.
  function contentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const texts: string[] = [];
    for (const part of content) {
      if (
        part !== null &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string' &&
        part.text.length > 0
      ) {
        texts.push(part.text);
      }
    }
    return texts.join('\n\n');
  }

  it('drops image parts entirely — no `[object Object]`, no data URL in the transcript', () => {
    const rendered = contentText(toUserContent('match this', [image(), image({ id: 'a2' })]));
    expect(rendered).toContain('match this');
    expect(rendered).not.toContain('object Object');
    expect(rendered).not.toContain('data:image/');
    expect(rendered).not.toContain('base64');
  });
});
