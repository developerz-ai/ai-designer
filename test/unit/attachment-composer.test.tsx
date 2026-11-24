// The mounted composer's attachment behaviour (#composer-attachments): the three ways material
// gets in (button / paste / drop), the big-paste promotion, and what happens to the tray on send.
//
// Same setup as `composer-view.test.tsx` — the chat/focus/settings stores are mocked because the
// components read them directly — with one deliberate difference: the REAL attachments store runs,
// because "a big paste becomes a chip" is a claim about the whole path, not about a mock. Only the
// codec below it is faked.
import { fireEvent, render, screen } from '@solidjs/testing-library';
import type { Setter } from 'solid-js';
import type { SetStoreFunction } from 'solid-js/store';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  ATTACHMENT_ONLY_TEXT,
  Composer,
  clipboardImages,
  isFileDrag,
} from '@/entrypoints/sidepanel/components/chat/Composer';
import type { EncodeImageResult } from '@/entrypoints/sidepanel/lib/image-encode';
import * as attachmentStore from '@/entrypoints/sidepanel/stores/attachments';
import * as chatStore from '@/entrypoints/sidepanel/stores/chat';
import * as settingsStore from '@/entrypoints/sidepanel/stores/settings';
import { BIG_PASTE_THRESHOLD_CHARS, MAX_IMAGE_ATTACHMENTS } from '@/shared/attachments';
import type { StableSelector } from '@/shared/messages';

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

vi.mock('@/entrypoints/sidepanel/lib/image-encode-client', () => ({ queueImageEncode: encode }));

vi.mock('@/entrypoints/sidepanel/stores/chat', async () => {
  const { createSignal } = await import('solid-js');
  const [streaming, setStreaming] = createSignal(false);
  return {
    streaming,
    send: vi.fn(async () => true),
    stopTurn: vi.fn(async () => {}),
    __setStreaming: setStreaming,
  };
});

vi.mock('@/entrypoints/sidepanel/stores/focus', async () => {
  const { createSignal } = await import('solid-js');
  const [selector] = createSignal<StableSelector | null>(null);
  const [pickerActive] = createSignal(false);
  const [multiSelectors] = createSignal<StableSelector[]>([]);
  const [recentReferences] = createSignal<StableSelector[]>([]);
  return {
    selector,
    pickerActive,
    multiSelectors,
    recentReferences,
    mentionReference: vi.fn(async () => {}),
    orderedReferences: () => [],
    removeReference: vi.fn(),
    startPicker: vi.fn(async () => {}),
    stopPicker: vi.fn(async () => {}),
    clearFocus: vi.fn(),
  };
});

vi.mock('@/entrypoints/sidepanel/stores/settings', async () => {
  const { createStore } = await import('solid-js/store');
  const [settings, setSettings] = createStore({
    model: null as string | null,
    models: [] as { id: string; name: string }[],
  });
  return { settings, switchModel: vi.fn(), __setSettings: setSettings };
});

const chat = chatStore as unknown as { send: Mock; __setStreaming: Setter<boolean> };
const settings = settingsStore as unknown as {
  __setSettings: SetStoreFunction<{ model: string | null; models: { id: string; name: string }[] }>;
};

const PLACEHOLDER = 'Tell the agent what to change…';
const BIG = 'x'.repeat(BIG_PASTE_THRESHOLD_CHARS + 1);
const SMALL = 'a short paste';

function input(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
}

function png(name = 'mockup.png'): File {
  return new File(['bytes'], name, { type: 'image/png' });
}

/** `fireEvent` returns false when a handler called `preventDefault()` — which is exactly the
 *  question for a paste: was it intercepted, or did it fall through to the field? */
function paste(text: string, files: File[] = []): boolean {
  return fireEvent.paste(input(), {
    clipboardData: {
      files,
      types: files.length > 0 ? ['Files'] : ['text/plain'],
      getData: () => text,
    },
  });
}

beforeEach(() => {
  attachmentStore.clearAttachments();
  chat.__setStreaming(false);
  settings.__setSettings({ model: null, models: [] });
  chat.send.mockClear();
  chat.send.mockResolvedValue(true);
  encode.mockClear();
});

describe('Composer — paste', () => {
  // The regression guard, and the reason this is the first test: an ordinary paste MUST behave
  // exactly as it did before attachments existed.
  it('leaves a short paste completely alone', () => {
    render(() => <Composer />);

    expect(paste(SMALL)).toBe(true); // not prevented — the field gets it, as always
    expect(attachmentStore.attachments()).toHaveLength(0);
  });

  it('promotes a big paste to a text attachment instead of flooding the field', () => {
    render(() => <Composer />);

    expect(paste(BIG)).toBe(false); // prevented — the field never sees it
    expect(input()).toHaveValue('');
    expect(attachmentStore.attachments()).toHaveLength(1);
    expect(screen.getByText('Pasted text 1')).toBeInTheDocument();
  });

  it('names each promoted paste distinctly, and can remove exactly one', () => {
    render(() => <Composer />);
    paste(BIG);
    paste(`${BIG}2`);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Pasted text 1' }));

    expect(attachmentStore.attachments().map((a) => a.name)).toEqual(['Pasted text 2']);
  });

  it('attaches a pasted image and does not let it reach the field', async () => {
    render(() => <Composer />);

    expect(paste('', [png('clip.png')])).toBe(false);
    await vi.waitFor(() => expect(attachmentStore.attachments()).toHaveLength(1));
    expect(screen.getByText('clip.png')).toBeInTheDocument();
  });
});

describe('Composer — file button and drop', () => {
  it('offers a file control distinct from the element picker', () => {
    render(() => <Composer />);

    expect(screen.getByRole('button', { name: 'Attach an image' })).toBeInTheDocument();
    // The picker is untouched — the two attach affordances mean different things.
    expect(
      screen.getByRole('button', { name: 'Pick an element to attach as context' }),
    ).toBeInTheDocument();
  });

  it('attaches dropped images and swallows the drop', async () => {
    const { container } = render(() => <Composer />);
    const composer = container.querySelector('.dz-composer') as HTMLElement;

    const dropped = fireEvent.drop(composer, {
      dataTransfer: { files: [png('drag.png')], types: ['Files'] },
    });

    // Prevented, or the panel NAVIGATES to the dropped file and the whole UI is gone.
    expect(dropped).toBe(false);
    await vi.waitFor(() => expect(attachmentStore.attachments()).toHaveLength(1));
  });

  it('ignores a drag that carries no files', () => {
    const { container } = render(() => <Composer />);
    const composer = container.querySelector('.dz-composer') as HTMLElement;

    expect(fireEvent.dragOver(composer, { dataTransfer: { types: ['text/plain'] } })).toBe(true);
  });
});

describe('Composer — send gate', () => {
  it('enables Send for an attachment with no text at all', async () => {
    render(() => <Composer />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    paste(BIG);

    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('sends a default instruction when there is material but no words', async () => {
    render(() => <Composer />);
    paste(BIG);

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => expect(chat.send).toHaveBeenCalled());

    const [text, mode, selector, attachments] = chat.send.mock.calls[0] ?? [];
    expect(text).toBe(ATTACHMENT_ONLY_TEXT);
    expect(mode).toBeUndefined();
    expect(selector).toBeUndefined();
    expect(attachments).toHaveLength(1);
  });

  it('carries the typed instruction and the attachments together', async () => {
    render(() => <Composer />);
    paste(BIG);
    fireEvent.input(input(), { target: { value: 'match this hero' } });

    fireEvent.keyDown(input(), { key: 'Enter' });
    await vi.waitFor(() => expect(chat.send).toHaveBeenCalled());

    expect(chat.send.mock.calls[0]?.[0]).toBe('match this hero');
    expect(chat.send.mock.calls[0]?.[3]).toHaveLength(1);
  });

  it('passes no attachments key at all when nothing is attached', async () => {
    render(() => <Composer />);
    fireEvent.input(input(), { target: { value: 'just words' } });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => expect(chat.send).toHaveBeenCalled());

    expect(chat.send).toHaveBeenCalledWith('just words', undefined, undefined, undefined);
  });

  it('clears the tray on a successful send', async () => {
    render(() => <Composer />);
    paste(BIG);

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await vi.waitFor(() => expect(attachmentStore.attachments()).toHaveLength(0));
  });

  // The real failure mode: a rejected send must not cost the user six re-picked files.
  it('KEEPS the tray when the send is rejected', async () => {
    chat.send.mockResolvedValue(false);
    render(() => <Composer />);
    paste(BIG);

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => expect(chat.send).toHaveBeenCalled());

    expect(attachmentStore.attachments()).toHaveLength(1);
    expect(screen.getByText('Pasted text 1')).toBeInTheDocument();
  });
});

describe('Composer — tray reports refusals', () => {
  it('shows the cap sentence when a 7th image is refused', async () => {
    render(() => <Composer />);
    await attachmentStore.addFiles(
      Array.from({ length: MAX_IMAGE_ATTACHMENTS }, (_, i) => png(`m${i}.png`)),
    );

    await attachmentStore.addFiles([png('seventh.png')]);

    expect(await screen.findByRole('status')).toHaveTextContent(String(MAX_IMAGE_ATTACHMENTS));
  });
});

describe('Composer — transfer helpers', () => {
  it('keeps only images off a clipboard, so an ordinary paste is never reported at', () => {
    const files = [png(), new File(['x'], 'notes.txt', { type: 'text/plain' })];
    expect(clipboardImages({ files }).map((f) => f.name)).toEqual(['mockup.png']);
    expect(clipboardImages(null)).toEqual([]);
  });

  // `files` is EMPTY during dragover — only the advertised types are there to test.
  it('detects a file drag from its types, not from its (empty) file list', () => {
    expect(isFileDrag({ types: ['Files'], files: [] })).toBe(true);
    expect(isFileDrag({ types: ['text/plain'] })).toBe(false);
    expect(isFileDrag(null)).toBe(false);
  });
});
