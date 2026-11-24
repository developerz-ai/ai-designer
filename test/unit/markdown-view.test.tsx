import { render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { MarkdownView } from '@/entrypoints/sidepanel/components/chat/MarkdownView';

// MarkdownView renders a STREAMING reply: the same text prop grows by a few characters dozens of
// times a second. What has to hold is that a token appending re-renders in place instead of
// disposing and rebuilding the whole answer — the pre-fix `<For each={parseMarkdown(...)}>`
// handed <For> a fresh object per block on every access, so every token remounted the entire
// rendered DOM (blowing away selection, scroll anchoring, and burning layout work per keystroke
// of the model).

describe('<MarkdownView> streaming stability', () => {
  it('does not remount the answer when a token appends', () => {
    const [text, setText] = createSignal('The hero uses a serif face');
    const { container } = render(() => <MarkdownView text={text()} />);

    const paragraph = container.querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraph?.textContent).toBe('The hero uses a serif face');

    setText('The hero uses a serif face at 48px');

    // Same element instance — position-keyed, so the growing last block updates in place.
    expect(container.querySelector('p')).toBe(paragraph);
    expect(paragraph?.textContent).toBe('The hero uses a serif face at 48px');
  });

  it('keeps earlier blocks mounted when streaming appends a new one', () => {
    const [text, setText] = createSignal('# Findings\n\nFirst paragraph.');
    const { container } = render(() => <MarkdownView text={text()} />);

    const heading = container.querySelector('h2');
    const first = container.querySelector('p');
    expect(heading?.textContent).toBe('Findings');
    expect(first?.textContent).toBe('First paragraph.');

    setText('# Findings\n\nFirst paragraph.\n\nSecond paragraph.');

    expect(container.querySelector('h2')).toBe(heading);
    expect(container.querySelector('p')).toBe(first);
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });
});
