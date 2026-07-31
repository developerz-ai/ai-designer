// ModelPicker is the inline model quick-switch, split out of Composer (#165). It reads
// `stores/settings` and dispatches `switchModel` itself — zero props — so the store is mocked
// here rather than injected. What matters is the menu contract, not pixels: the trigger is gated
// on there being models at all, `aria-expanded` tracks the menu, the menu is genuinely absent
// from the DOM when closed (a hidden-but-present menu keeps its items focusable and in the
// accessibility tree), selection both dispatches and closes, and Escape closes AND returns focus
// to the trigger instead of dropping it on `<body>`.
import { fireEvent, render, screen } from '@solidjs/testing-library';
import type { SetStoreFunction } from 'solid-js/store';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ModelPicker, nextMenuIndex } from '@/entrypoints/sidepanel/components/chat/ModelPicker';
import * as settingsStore from '@/entrypoints/sidepanel/stores/settings';

interface FakeSettings {
  model: string | null;
  models: { id: string; name: string }[];
}

// The factory runs on first import of the mocked module, so it may build the real Solid store it
// stands in for — the component only reacts if `settings` is genuinely reactive.
vi.mock('@/entrypoints/sidepanel/stores/settings', async () => {
  const { createStore } = await import('solid-js/store');
  const [settings, setSettings] = createStore<FakeSettings>({ model: null, models: [] });
  return { settings, switchModel: vi.fn(), __setSettings: setSettings };
});

const mocked = settingsStore as unknown as {
  settings: FakeSettings;
  switchModel: Mock;
  __setSettings: SetStoreFunction<FakeSettings>;
};

const MODELS = [
  { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4' },
  { id: 'openai/gpt-5', name: 'GPT-5' },
  { id: 'google/gemini-3-pro', name: 'Gemini 3 Pro' },
];

// Menu items carry `role="menuitemradio"`, which replaces their implicit button role — so the
// only `button` in this subtree is always the trigger, open or closed.
function trigger(): HTMLElement {
  return screen.getByRole('button');
}

beforeEach(() => {
  mocked.__setSettings({ model: null, models: [] });
  mocked.switchModel.mockClear();
});

describe('nextMenuIndex', () => {
  it('wraps in both directions and honours Home/End', () => {
    expect(nextMenuIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextMenuIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', 0, 3)).toBe(2);
    expect(nextMenuIndex('ArrowUp', 2, 3)).toBe(1);
    expect(nextMenuIndex('Home', 2, 3)).toBe(0);
    expect(nextMenuIndex('End', 0, 3)).toBe(2);
  });

  it('is null for keys that are not a move, and for an empty menu', () => {
    expect(nextMenuIndex('a', 0, 3)).toBeNull();
    expect(nextMenuIndex('Enter', 0, 3)).toBeNull();
    expect(nextMenuIndex('ArrowDown', 0, 0)).toBeNull();
  });
});

describe('ModelPicker', () => {
  it('disables the trigger while no models are loaded', () => {
    render(() => <ModelPicker />);
    expect(trigger()).toBeDisabled();
  });

  it('enables the trigger and shows the current model once models load', () => {
    render(() => <ModelPicker />);
    mocked.__setSettings({ models: MODELS, model: 'openai/gpt-5' });

    expect(trigger()).toBeEnabled();
    expect(trigger()).toHaveTextContent('openai/gpt-5');
  });

  it('keeps the menu out of the DOM until opened, and flips aria-expanded', () => {
    mocked.__setSettings({ models: MODELS, model: null });
    render(() => <ModelPicker />);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(MODELS.length);
    expect(screen.getByRole('button', { expanded: true })).toHaveAttribute('aria-expanded', 'true');
  });

  it('announces the trigger as a menu button pointing at the open menu', () => {
    mocked.__setSettings({ models: MODELS, model: null });
    render(() => <ModelPicker />);
    const t = screen.getByRole('button');
    expect(t).toHaveAttribute('aria-haspopup', 'menu');

    fireEvent.click(t);
    expect(t.getAttribute('aria-controls')).toBe(screen.getByRole('menu').id);
  });

  it('marks only the selected model as checked', () => {
    mocked.__setSettings({ models: MODELS, model: 'openai/gpt-5' });
    render(() => <ModelPicker />);
    fireEvent.click(screen.getByRole('button'));

    const checked = screen
      .getAllByRole('menuitemradio')
      .filter((i) => i.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveTextContent('GPT-5');
  });

  it('dispatches switchModel and closes when an item is chosen', () => {
    mocked.__setSettings({ models: MODELS, model: null });
    render(() => <ModelPicker />);
    fireEvent.click(screen.getByRole('button'));

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Gemini 3 Pro' }));

    expect(mocked.switchModel).toHaveBeenCalledExactlyOnceWith('google/gemini-3-pro');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens with focus on the current model, not on the first item', () => {
    mocked.__setSettings({ models: MODELS, model: 'google/gemini-3-pro' });
    render(() => <ModelPicker />);
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('menuitemradio', { name: 'Gemini 3 Pro' })).toHaveFocus();
  });

  it('moves focus between items with the arrow keys, wrapping at the end', () => {
    mocked.__setSettings({ models: MODELS, model: null });
    render(() => <ModelPicker />);
    fireEvent.click(screen.getByRole('button'));
    const menu = screen.getByRole('menu');

    expect(screen.getByRole('menuitemradio', { name: 'Claude Opus 4' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemradio', { name: 'GPT-5' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitemradio', { name: 'Gemini 3 Pro' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemradio', { name: 'Claude Opus 4' })).toHaveFocus();
  });

  // The whole point of the roving pattern: Tab must leave the menu, so only the active item is
  // tabbable and every other item is -1.
  it('keeps exactly one tabbable item', () => {
    mocked.__setSettings({ models: MODELS, model: null });
    render(() => <ModelPicker />);
    fireEvent.click(screen.getByRole('button'));

    const tabbable = screen
      .getAllByRole('menuitemradio')
      .filter((i) => i.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
  });

  it('closes on Escape and returns focus to the trigger', () => {
    mocked.__setSettings({ models: MODELS, model: null });
    render(() => <ModelPicker />);
    const t = screen.getByRole('button');
    fireEvent.click(t);

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(t).toHaveFocus();
    expect(mocked.switchModel).not.toHaveBeenCalled();
  });

  it('opens on ArrowDown from the trigger', () => {
    mocked.__setSettings({ models: MODELS, model: null });
    render(() => <ModelPicker />);

    fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowDown' });

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Claude Opus 4' })).toHaveFocus();
  });

  it('opens on ArrowUp from the trigger with the last item active', () => {
    mocked.__setSettings({ models: MODELS, model: null });
    render(() => <ModelPicker />);

    fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowUp' });

    expect(screen.getByRole('menuitemradio', { name: 'Gemini 3 Pro' })).toHaveFocus();
  });
});
