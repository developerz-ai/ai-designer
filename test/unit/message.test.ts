import { render, within } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import {
  editsSummary,
  Message,
  showMarkdown,
  speakerLabel,
} from '@/entrypoints/sidepanel/components/chat/Message';

// Message's rendering contract exercised through its pure building blocks (mirrors
// tool-chip.test.ts / icon.test.ts) — role variant and edits pluralization — plus a mounted
// check that a turn still names its speaker now that the invalid `role="user"`/`role="assistant"`
// is gone. The per-call tool status moved out with the tool region itself: see
// tool-call-list.test.tsx.
//
// Mounted without JSX (a Solid component is just a function of props), so this spec stays a
// plain `.ts` file. `Message` renders an `<li>`, so it is mounted into a real `<ul>` — that is
// what maps it to the `listitem` role.
function mountTurn(props: Parameters<typeof Message>[0]) {
  const list = document.body.appendChild(document.createElement('ul'));
  render(() => Message(props), { container: list });
  return within(list).getByRole('listitem');
}

describe('showMarkdown', () => {
  it('renders assistant text through markdown', () => {
    expect(showMarkdown('assistant')).toBe(true);
  });

  it.each(['user', 'system'] as const)('renders "%s" text as plain text', (role) => {
    expect(showMarkdown(role)).toBe(false);
  });
});

describe('speakerLabel', () => {
  it('names the two speakers a thread actually has', () => {
    expect(speakerLabel('user')).toBe('You');
    expect(speakerLabel('assistant')).toBe('Agent');
  });

  it('gives a system notice no speaker — nobody said it', () => {
    expect(speakerLabel('system')).toBeUndefined();
  });
});

describe('<Message> speaker', () => {
  it('names its speaker before the turn content, without showing it', () => {
    const turn = mountTurn({ role: 'user', text: 'Recolor the CTA' });

    // The label is the turn's first content, so it is read before the words.
    expect(turn).toHaveTextContent(/^You/);
    const speaker = turn.querySelector('.dz-message__speaker');
    expect(speaker).toHaveTextContent('You');
    // Off-screen, not display:none — removing it from the a11y tree would defeat the point.
    expect(speaker).toBeInTheDocument();
    expect(speaker).toHaveClass('dz-message__speaker');
  });

  it('distinguishes the agent turn from the user turn by name, not just by tone', () => {
    const turn = mountTurn({ role: 'assistant', text: 'Recolored it.' });

    expect(turn).toHaveTextContent(/^Agent/);
    expect(turn).toHaveClass('dz-message--assistant');
  });

  it('adds no speaker text to a system notice', () => {
    const turn = mountTurn({ role: 'system', text: 'Session stopped.' });

    expect(turn.querySelector('.dz-message__speaker')).toBeNull();
    expect(turn).toHaveTextContent('Session stopped.');
  });
});

describe('editsSummary', () => {
  it('uses the singular for exactly one edit', () => {
    expect(editsSummary(1)).toBe('1 edit recorded');
  });

  it.each([0, 2, 5])('uses the plural for %i edits', (count) => {
    expect(editsSummary(count)).toBe(`${count} edits recorded`);
  });
});
