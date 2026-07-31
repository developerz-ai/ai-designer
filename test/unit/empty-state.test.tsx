// The intro state (#165): Leo's left-aligned rows replaced centred wrapped pills. Nothing here
// asserts layout — what has to hold is that every suggestion is a real, individually named
// control and that tapping one dispatches that exact suggestion (its `prompt` and `mode`, not
// its visible label, which is what actually reaches `send()`).
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState } from '@/entrypoints/sidepanel/components/chat/EmptyState';
import { SUGGESTIONS } from '@/entrypoints/sidepanel/components/chat/SuggestionChips';

describe('EmptyState', () => {
  it('renders one row per suggestion, each named by its label', () => {
    render(() => <EmptyState onSelectSuggestion={() => {}} />);

    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(SUGGESTIONS.length);
    for (const s of SUGGESTIONS) {
      expect(screen.getByRole('button', { name: s.label })).toBeInTheDocument();
    }
  });

  it('dispatches the whole suggestion object for the row clicked', () => {
    const onSelectSuggestion = vi.fn();
    render(() => <EmptyState onSelectSuggestion={onSelectSuggestion} />);

    SUGGESTIONS.forEach((s, i) => {
      fireEvent.click(screen.getByRole('button', { name: s.label }));
      expect(onSelectSuggestion).toHaveBeenNthCalledWith(i + 1, s);
    });
    expect(onSelectSuggestion).toHaveBeenCalledTimes(SUGGESTIONS.length);
  });

  it('titles the intro with a heading, so it is reachable by heading navigation', () => {
    render(() => <EmptyState onSelectSuggestion={() => {}} />);
    expect(screen.getByRole('heading')).toHaveTextContent('Tell the agent what to build');
  });

  // Leo's "Automatic ⓘ": the glyph is decorative (Icon renders aria-hidden), so the explanation
  // it stands for is carried as visually-hidden text rather than a `title` a screen reader and a
  // keyboard user both miss.
  it('announces what "Automatic" means alongside the meta line', () => {
    const { container } = render(() => <EmptyState onSelectSuggestion={() => {}} />);
    const meta = container.querySelector('.dz-empty-state__meta');

    expect(meta).toHaveTextContent('Automatic');
    expect(meta).toHaveTextContent('Copy, debug or plain chat — picked from what you ask');
  });
});
