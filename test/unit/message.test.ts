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
  // First in document order = the turn itself. A turn WITH tool calls nests a second list of
  // `listitem`s (ToolCallList's chips), so a bare `getByRole` throws on "found multiple".
  const turn = within(list).getAllByRole('listitem')[0];
  if (!turn) throw new Error('Message rendered no turn');
  return turn;
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

// The working line is the ONLY thing on screen between send and the first token, and it used to be
// a hardcoded "Editing the page…" — false, since every turn reads first. It now says what the
// turn's latest tool call is actually doing (`turn-phase.ts`, unit-tested separately); these cases
// pin the wiring: still triggered by `streaming`, still carrying its dots, no longer lying.
describe('<Message> working line', () => {
  it('says it is getting started before any tool has run, instead of claiming an edit', () => {
    const turn = mountTurn({ role: 'assistant', text: '', streaming: true });

    const working = turn.querySelector('.dz-message__working');
    expect(working).toHaveTextContent('Getting started');
    expect(working).not.toHaveTextContent('Editing the page');
    // The three pulsing dots stay, and stay hidden from the a11y tree — they are decoration.
    expect(working?.querySelectorAll('.dz-message__dots span')).toHaveLength(3);
    expect(working?.querySelector('.dz-message__dots')).toHaveAttribute('aria-hidden', 'true');
  });

  it('never ends the phase in an ellipsis — the animated dots already say "still going"', () => {
    // The dots animate to the LEFT of this text. A trailing "…" states the same thing a second
    // time in the same line ("⋯ Reading the page…"), which is why every phase string dropped it.
    // Asserted over EVERY phase, not just the one on screen, so a new phase cannot reintroduce it.
    for (const calls of [
      [],
      [{ tool: 'query' }],
      [{ tool: 'screenshot' }],
      [{ tool: 'setStyle' }],
      [{ tool: 'handoff' }],
      [{ tool: 'some_mcp_tool' }],
    ]) {
      const turn = mountTurn({ role: 'assistant', text: '', streaming: true, toolCalls: calls });
      const text = turn.querySelector('.dz-message__working')?.textContent?.trim() ?? '';
      expect(text.length, JSON.stringify(calls)).toBeGreaterThan(0);
      expect(text.endsWith('…'), text).toBe(false);
      expect(text.endsWith('...'), text).toBe(false);
    }
  });

  it('names the read the agent is actually doing', () => {
    const turn = mountTurn({
      role: 'assistant',
      text: '',
      streaming: true,
      toolCalls: [{ tool: 'pageFacts' }],
    });

    expect(turn.querySelector('.dz-message__working')).toHaveTextContent('Reading the page');
  });

  it('says "editing" only once a mutation is the latest call', () => {
    const turn = mountTurn({
      role: 'assistant',
      text: '',
      streaming: true,
      toolCalls: [{ tool: 'pageFacts' }, { tool: 'setStyle' }],
    });

    expect(turn.querySelector('.dz-message__working')).toHaveTextContent('Editing the page');
  });

  it('drops the working line as soon as the first token lands', () => {
    // Once the reply itself is on screen (with its caret), a status line under it reads as a
    // second speaker — the gate is `text.length === 0`, not just `streaming`.
    const turn = mountTurn({
      role: 'assistant',
      text: 'Right, first I looked at',
      streaming: true,
      toolCalls: [{ tool: 'setStyle' }],
    });

    expect(turn.querySelector('.dz-message__working')).toBeNull();
  });

  it('shows no working line on a settled turn, or on a user turn', () => {
    expect(
      mountTurn({ role: 'assistant', text: 'Done.' }).querySelector('.dz-message__working'),
    ).toBeNull();
    expect(
      mountTurn({ role: 'user', text: 'Recolor it', streaming: true }).querySelector(
        '.dz-message__working',
      ),
    ).toBeNull();
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
