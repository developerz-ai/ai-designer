// Mounted Composer contract (#165). `composer.test.ts` covers the pure `isSubmitKey` predicate;
// this covers what only a real mount can show: the accessible names four e2e specs match, the
// single send/stop slot, the textarea keeping a name once the placeholder is gone, and the
// picked element actually reaching `send()`.
//
// The stores are mocked because Composer/ContextChip/ModelPicker read them directly (zero props,
// by design) and the real ones talk to `chrome.runtime`. Each factory builds the genuine Solid
// primitive it stands in for — the component only re-renders if `streaming`/`selector` are real
// signals.
import { fireEvent, render, screen } from '@solidjs/testing-library';
import type { Setter } from 'solid-js';
import type { SetStoreFunction } from 'solid-js/store';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { Composer } from '@/entrypoints/sidepanel/components/chat/Composer';
import * as chatStore from '@/entrypoints/sidepanel/stores/chat';
import * as focusStore from '@/entrypoints/sidepanel/stores/focus';
import * as settingsStore from '@/entrypoints/sidepanel/stores/settings';
import type { StableSelector } from '@/shared/messages';

vi.mock('@/entrypoints/sidepanel/stores/chat', async () => {
  const { createSignal } = await import('solid-js');
  const [streaming, setStreaming] = createSignal(false);
  return {
    streaming,
    send: vi.fn(async () => {}),
    stopTurn: vi.fn(async () => {}),
    __setStreaming: setStreaming,
  };
});

vi.mock('@/entrypoints/sidepanel/stores/focus', async () => {
  const { createSignal } = await import('solid-js');
  const [selector, setSelector] = createSignal<StableSelector | null>(null);
  const [pickerActive, setPickerActive] = createSignal(false);
  // `ElementRefs` (rendered by Composer) reads the multi-select half of the store too, and
  // derives its numbered chips through `orderedReferences`. Both are part of the store's real
  // surface, so the fake carries them rather than letting the component throw on `undefined()`.
  const [multiSelectors, setMultiSelectors] = createSignal<StableSelector[]>([]);
  return {
    selector,
    pickerActive,
    multiSelectors,
    orderedReferences: (pin: StableSelector | null, multi: StableSelector[]) =>
      pin ? [pin, ...multi] : multi,
    removeReference: vi.fn(),
    startPicker: vi.fn(async () => {}),
    stopPicker: vi.fn(async () => {}),
    clearFocus: vi.fn(),
    __setSelector: setSelector,
    __setPickerActive: setPickerActive,
    __setMultiSelectors: setMultiSelectors,
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

const chat = chatStore as unknown as {
  send: Mock;
  stopTurn: Mock;
  __setStreaming: Setter<boolean>;
};
const focus = focusStore as unknown as {
  startPicker: Mock;
  __setSelector: Setter<StableSelector | null>;
  __setPickerActive: Setter<boolean>;
};
const settings = settingsStore as unknown as {
  __setSettings: SetStoreFunction<{ model: string | null; models: { id: string; name: string }[] }>;
};

const PICKED: StableSelector = {
  strategy: 'id',
  value: '#cta',
  fragile: false,
};

const PLACEHOLDER = 'Tell the agent what to change…';

function input(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
}

function type(text: string): void {
  fireEvent.input(input(), { target: { value: text } });
}

beforeEach(() => {
  chat.__setStreaming(false);
  focus.__setSelector(null);
  focus.__setPickerActive(false);
  settings.__setSettings({ model: null, models: [] });
  chat.send.mockClear();
  chat.stopTurn.mockClear();
  focus.startPicker.mockClear();
});

describe('Composer — accessible names', () => {
  // The regression guard for the defect this replaced: the placeholder WAS the only name, so the
  // field went nameless the moment anyone typed into it.
  it('keeps an accessible name on the textarea once it has content', () => {
    render(() => <Composer />);
    expect(input()).toHaveAccessibleName('Message the agent');

    type('make the hero bigger');

    expect(input()).toHaveValue('make the hero bigger');
    expect(input()).toHaveAccessibleName('Message the agent');
  });

  it('announces the keyboard shortcut as a description', () => {
    render(() => <Composer />);
    expect(input()).toHaveAccessibleDescription('Press Enter to send, Shift+Enter for a new line');
    expect(input()).toHaveAttribute('aria-keyshortcuts', 'Enter');
  });

  // `title` alone is a low-quality accessible name (WAI-ARIA APG) and unreachable without a
  // pointer; the attach control now carries a real label.
  it('names the attach control without relying on title', () => {
    render(() => <Composer />);
    const attach = screen.getByRole('button', { name: 'Pick an element to attach as context' });

    expect(attach).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(attach);
    expect(focus.startPicker).toHaveBeenCalledOnce();
  });

  // Pressed tracks the PICKER, not the pin. It used to stay pressed for as long as anything was
  // attached, which made an accent-filled button the composer's resting state — and now that
  // attached elements render as chips directly above the shell, it was saying the same thing
  // twice. Pressed now means exactly "the next click on the page will be captured".
  it('marks attach as pressed while the picker is armed, not merely while something is pinned', () => {
    render(() => <Composer />);
    const attach = () =>
      screen.getByRole('button', { name: 'Pick an element to attach as context' });

    focus.__setSelector(PICKED);
    expect(attach()).toHaveAttribute('aria-pressed', 'false');

    focus.__setPickerActive(true);
    expect(attach()).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Composer — send/stop is one slot', () => {
  it('disables Send for an empty draft and for whitespace only', () => {
    render(() => <Composer />);
    const send = screen.getByRole('button', { name: 'Send' });

    expect(send).toBeDisabled();
    type('   \n\t  ');
    expect(send).toBeDisabled();

    type('do the thing');
    expect(send).toBeEnabled();
  });

  it('swaps Send for Stop in the same slot while streaming — never both', () => {
    render(() => <Composer />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();

    chat.__setStreaming(true);

    // Exactly `Stop` — e2e scopes this to `.dz-composer` because the header toggle shares it.
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('keeps Stop enabled and dispatches stopTurn', () => {
    render(() => <Composer />);
    chat.__setStreaming(true);
    const stop = screen.getByRole('button', { name: 'Stop' });

    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(chat.stopTurn).toHaveBeenCalledOnce();
    expect(chat.send).not.toHaveBeenCalled();
  });

  // C4: `disabled` would blur the field and drop focus on `<body>` mid-turn.
  it('never disables the textarea while a turn streams', () => {
    render(() => <Composer />);
    input().focus();
    chat.__setStreaming(true);

    expect(input()).toBeEnabled();
    expect(input()).not.toHaveAttribute('readonly');
    expect(input()).toHaveFocus();
  });
});

describe('Composer — send dispatch', () => {
  it('sends the draft with no selector when nothing is pinned', () => {
    render(() => <Composer />);
    type('make it pop');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(chat.send).toHaveBeenCalledExactlyOnceWith('make it pop', undefined, undefined);
  });

  // C11 — the product's signature bug: "click an element, say make this bigger" used to reach
  // the agent with no target at all.
  it('passes the pinned element as the third argument to send()', () => {
    render(() => <Composer />);
    focus.__setSelector(PICKED);
    type('make this bigger');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(chat.send).toHaveBeenCalledExactlyOnceWith('make this bigger', undefined, PICKED);
  });

  it('sends on Enter and clears the draft', () => {
    render(() => <Composer />);
    type('ship it');
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(chat.send).toHaveBeenCalledExactlyOnceWith('ship it', undefined, undefined);
    expect(input()).toHaveValue('');
  });

  it('does not send on the Enter that commits an IME candidate', () => {
    render(() => <Composer />);
    type('日本語');
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });

    expect(chat.send).not.toHaveBeenCalled();
    expect(input()).toHaveValue('日本語');
  });

  it('does not send on Shift+Enter', () => {
    render(() => <Composer />);
    type('line one');
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });

    expect(chat.send).not.toHaveBeenCalled();
  });
});
