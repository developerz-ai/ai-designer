import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import {
  filterModels,
  ModelCombobox,
  nextOptionIndex,
} from '@/entrypoints/sidepanel/components/ModelCombobox';

// ModelCombobox is the control that replaced the model `<select>`: a searchable view of whatever
// /models returned, over an input whose text IS the model id. Both halves matter — OpenRouter's
// catalogue is ~300 entries (unusable unfiltered) and a brand-new id like `minimax/hailuo-3` is
// not in any catalogue yet, so it has to be typeable.

const MODELS = [
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' },
  { id: 'minimax/hailuo-2', name: 'MiniMax Hailuo 2' },
  { id: 'qwen/qwen3.7-flash', name: 'Qwen3.7 Flash' },
];

describe('filterModels', () => {
  it('matches on the id and on the display name, case-insensitively', () => {
    expect(filterModels(MODELS, 'minimax/').map((m) => m.id)).toEqual(['minimax/hailuo-2']);
    expect(filterModels(MODELS, 'HAILUO').map((m) => m.id)).toEqual(['minimax/hailuo-2']);
    expect(filterModels(MODELS, 'flash').map((m) => m.id)).toEqual(['qwen/qwen3.7-flash']);
  });

  it('returns everything for an empty/whitespace query and nothing for a miss', () => {
    expect(filterModels(MODELS, '')).toHaveLength(3);
    expect(filterModels(MODELS, '   ')).toHaveLength(3);
    expect(filterModels(MODELS, 'nope')).toHaveLength(0);
  });
});

describe('nextOptionIndex', () => {
  it('wraps at both ends and honours Home/End', () => {
    expect(nextOptionIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextOptionIndex('ArrowUp', 0, 3)).toBe(2);
    expect(nextOptionIndex('Home', 2, 3)).toBe(0);
    expect(nextOptionIndex('End', 0, 3)).toBe(2);
  });

  it('is a no-op for a non-navigation key or an empty list', () => {
    expect(nextOptionIndex('a', 0, 3)).toBeNull();
    expect(nextOptionIndex('ArrowDown', 0, 0)).toBeNull();
  });
});

function mount(value = '', onCommit = vi.fn()) {
  render(() => (
    <ModelCombobox id="dz-test-model" value={value} options={MODELS} onCommit={onCommit} />
  ));
  return {
    input: screen.getByRole('combobox') as HTMLInputElement,
    onCommit,
  };
}

describe('ModelCombobox', () => {
  it('shows the committed value when closed', () => {
    const { input } = mount('qwen/qwen3.7-flash');
    expect(input.value).toBe('qwen/qwen3.7-flash');
  });

  it('offers the typed text as its own row when it is not an exact id in the list', () => {
    const { input } = mount();
    fireEvent.input(input, { target: { value: 'minimax/hailuo-3' } });
    expect(screen.getByText('Use “minimax/hailuo-3”')).toBeVisible();
  });

  it('does NOT offer the custom row when the typed text is already an exact id', () => {
    const { input } = mount();
    fireEvent.input(input, { target: { value: 'minimax/hailuo-2' } });
    expect(screen.queryByText('Use “minimax/hailuo-2”')).toBeNull();
  });

  it('commits a free-typed id on Enter — the paste path', () => {
    const { input, onCommit } = mount();
    fireEvent.input(input, { target: { value: 'minimax/hailuo-3' } });
    // The custom row sits first, so the default highlight IS the typed text.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('minimax/hailuo-3');
  });

  it('commits the highlighted option after arrowing past the custom row', () => {
    const { input, onCommit } = mount();
    fireEvent.input(input, { target: { value: 'hailuo' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // custom row -> first match
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('minimax/hailuo-2');
  });

  it('commits a click on an option', () => {
    const { input, onCommit } = mount();
    fireEvent.input(input, { target: { value: 'flash' } });
    fireEvent.click(screen.getByText('Qwen3.7 Flash'));
    expect(onCommit).toHaveBeenCalledWith('qwen/qwen3.7-flash');
  });

  it('commits on blur so clicking Save straight after a paste keeps the id', () => {
    const { input, onCommit } = mount();
    fireEvent.input(input, { target: { value: 'minimax/hailuo-3' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('minimax/hailuo-3');
  });

  it('Escape abandons the filter and restores the committed value without committing', () => {
    const { input, onCommit } = mount('qwen/qwen3.7-flash');
    fireEvent.input(input, { target: { value: 'gpt' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('qwen/qwen3.7-flash');
  });
});
