import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import {
  ToolCallList,
  toolCallOutcome,
  toolCallStatusLabel,
  toolChipStatusFor,
} from '@/entrypoints/sidepanel/components/chat/ToolCallList';

// The tool region extracted out of Message (#165). Two things are under test: the truth table
// that replaced Message's fabricated-status helper, and the rendered contract — order, the
// zero-call case, and that a failure is distinguishable from a success rather than both landing
// on a green check.

describe('toolCallOutcome', () => {
  it('reports a real success only when the call carries one', () => {
    expect(toolCallOutcome({ ok: true }, false)).toBe('done');
    expect(toolCallOutcome({ ok: true }, true)).toBe('done');
  });

  it('reports a real failure only when the call carries one', () => {
    expect(toolCallOutcome({ ok: false }, false)).toBe('failed');
    expect(toolCallOutcome({ ok: false }, true)).toBe('failed');
  });

  // The bug this replaces: the old helper returned 'done' for every call it wasn't sure about,
  // so a tool the model had merely *requested* — or one that failed and was retried elsewhere —
  // rendered as a green check claiming it had landed.
  it('never invents a success for a call with no outcome', () => {
    expect(toolCallOutcome({}, true)).toBe('running');
    expect(toolCallOutcome({}, false)).toBe('pending');
    expect(toolCallOutcome({ ok: undefined }, false)).toBe('pending');
  });

  it('defaults to the settled reading when no streaming flag is passed', () => {
    expect(toolCallOutcome({})).toBe('pending');
  });
});

describe('toolChipStatusFor', () => {
  it('maps each outcome onto the three states ToolChip speaks', () => {
    expect(toolChipStatusFor('done')).toBe('done');
    expect(toolChipStatusFor('failed')).toBe('error');
    expect(toolChipStatusFor('running')).toBe('running');
    // Pending borrows the running glyph; the list stills its animation.
    expect(toolChipStatusFor('pending')).toBe('running');
  });
});

describe('toolCallStatusLabel', () => {
  it('gives every outcome a word, so the state is not carried by color alone', () => {
    expect(toolCallStatusLabel('pending')).toBe('pending');
    expect(toolCallStatusLabel('running')).toBe('running');
    expect(toolCallStatusLabel('done')).toBe('done');
    expect(toolCallStatusLabel('failed')).toBe('failed');
  });
});

describe('<ToolCallList>', () => {
  it('renders nothing at all — not an empty list — when a turn made no tool calls', () => {
    const { container } = render(() => <ToolCallList calls={[]} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(container.querySelector('ol')).toBeNull();
  });

  it('renders one item per call, in call order', () => {
    render(() => (
      <ToolCallList
        calls={[
          { tool: 'browse', kind: 'read', ok: true },
          { tool: 'extractIdentity', kind: 'read', ok: true },
          { tool: 'setStyle', kind: 'act', selector: '#hero', ok: true },
        ]}
      />
    ));

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items.map((li) => li.querySelector('.dz-tool-chip__name')?.textContent)).toEqual([
      'browse',
      'extractIdentity',
      'setStyle',
    ]);
  });

  it('distinguishes a failed call from a successful one, and says why it failed', () => {
    render(() => (
      <ToolCallList
        calls={[
          { tool: 'recordEdit', ok: true },
          { tool: 'setText', selector: '#gone', ok: false, error: 'no element matches #gone' },
        ]}
      />
    ));

    const [done, failed] = screen.getAllByRole('listitem');
    expect(done).toHaveAttribute('data-status', 'done');
    expect(done?.querySelector('.dz-tool-chip')).toHaveClass('dz-tool-chip--done');

    expect(failed).toHaveAttribute('data-status', 'failed');
    expect(failed?.querySelector('.dz-tool-chip')).toHaveClass('dz-tool-chip--error');
    expect(failed?.querySelector('.dz-tool-chip')).not.toHaveClass('dz-tool-chip--done');
    // The reason is content, not just a color — it is the only thing that makes a red chip
    // actionable.
    expect(failed).toHaveTextContent('no element matches #gone');
    expect(done).not.toHaveTextContent('no element matches #gone');
  });

  // The distinction that survives with the stylesheet switched off, a monochrome display, or a
  // screen reader: no class, no data attribute, no color — just the words in the tree.
  it('distinguishes a failed call from a successful one by text alone', () => {
    render(() => (
      <ToolCallList
        calls={[
          { tool: 'recordEdit', ok: true },
          { tool: 'setText', ok: false, error: 'no element matches #gone' },
        ]}
      />
    ));

    const [done, failed] = screen.getAllByRole('listitem');
    if (!done || !failed) throw new Error('expected two rendered calls');

    expect(within(done).getByText('done')).toBeInTheDocument();
    expect(within(done).queryByText('failed')).not.toBeInTheDocument();

    expect(within(failed).getByText('failed')).toBeInTheDocument();
    expect(within(failed).queryByText('done')).not.toBeInTheDocument();
    expect(within(failed).getByText('no element matches #gone')).toBeInTheDocument();
  });

  it('labels an unknown outcome as pending in words, not only in tone', () => {
    render(() => <ToolCallList calls={[{ tool: 'browse' }]} />);

    const [item] = screen.getAllByRole('listitem');
    if (!item) throw new Error('expected one rendered call');
    expect(within(item).getByText('pending')).toBeInTheDocument();
    expect(within(item).queryByText('done')).not.toBeInTheDocument();
  });

  it('shows a call with no outcome as pending, never as done', () => {
    render(() => <ToolCallList calls={[{ tool: 'setStyle', selector: '#cta', kind: 'act' }]} />);

    const [item] = screen.getAllByRole('listitem');
    expect(item).toHaveAttribute('data-status', 'pending');
    expect(item?.querySelector('.dz-tool-chip')).not.toHaveClass('dz-tool-chip--done');
  });

  it('shows the newest outcome-less call as running while the turn is still streaming', () => {
    render(() => <ToolCallList calls={[{ tool: 'browse', kind: 'read' }]} streaming />);

    const [item] = screen.getAllByRole('listitem');
    expect(item).toHaveAttribute('data-status', 'running');
  });

  it('expands a call to reveal the selector it acted on', () => {
    render(() => <ToolCallList calls={[{ tool: 'setStyle', selector: '#cta', ok: true }]} />);

    const row = screen.getByRole('button', { name: /setStyle/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('#cta')).not.toBeInTheDocument();

    fireEvent.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('#cta')).toBeInTheDocument();
  });
});
