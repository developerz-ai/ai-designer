import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import {
  collapsedCalls,
  failedCount,
  pinnedCalls,
  runGlyph,
  ToolCallList,
  type ToolCallView,
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

// A run is COLLAPSED by default (a turn routinely fires 6-12 calls), so anything asserting on the
// individual chips has to open it first. The header is the only always-rendered control, and its
// accessible name IS its visible text — no aria-label, so a screen reader and a voice-control user
// get the same "12 actions · 1 failed" the screen shows (WCAG 2.5.3 Label in Name).
function runHeader(): HTMLElement {
  return screen.getByRole('button', { name: /\d+ actions?/ });
}

function expandRun(): void {
  fireEvent.click(runHeader());
}

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

    expandRun();

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

    expandRun();

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

    expandRun();

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

    expandRun();

    const [item] = screen.getAllByRole('listitem');
    if (!item) throw new Error('expected one rendered call');
    expect(within(item).getByText('pending')).toBeInTheDocument();
    expect(within(item).queryByText('done')).not.toBeInTheDocument();
  });

  it('shows a call with no outcome as pending, never as done', () => {
    render(() => <ToolCallList calls={[{ tool: 'setStyle', selector: '#cta', kind: 'act' }]} />);

    expandRun();

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

    expandRun();

    const row = screen.getByRole('button', { name: /setStyle/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('#cta')).not.toBeInTheDocument();

    fireEvent.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('#cta')).toBeInTheDocument();
  });
});

// ── Collapse contract ──────────────────────────────────────────────────────────────────────
// A turn routinely fires 6-12 calls. Expanded, they pushed the assistant's actual answer off the
// top of the thread. Collapsed, the header states the shape of the run and the rows anybody
// wants — whatever is in flight, and anything that failed — stay on screen.
//
// The invariant that outranks all of it: a collapsed run that HAS calls never shows zero rows.
// It used to render `pinnedCalls` directly, and every outcome of a successful run settles to
// `done`, so the group emptied itself the instant the run finished — reported as "3 actions:
// pageFacts, describe, screenshot ... then disappears", leaving a short answer looking like
// nothing had run at all.
describe('collapsed runs', () => {
  const RUN: ToolCallView[] = [
    { tool: 'extractIdentity', ok: true },
    { tool: 'screenshot', ok: true },
    { tool: 'setStyle', selector: '#gone', ok: false, error: 'no element matches #gone' },
    { tool: 'setText', ok: true },
  ];

  // The exact run from the report: three reads, all fine, nothing to pin.
  const SETTLED: ToolCallView[] = [
    { tool: 'pageFacts', kind: 'info', ok: true },
    { tool: 'describe', kind: 'read', ok: true },
    { tool: 'screenshot', kind: 'read', ok: true },
  ];

  it('pins the running and failed calls, and only those', () => {
    expect(pinnedCalls(RUN).map((c) => c.tool)).toEqual(['setStyle']);
    // Streaming turns an outcome-less call into a running one, so it pins too.
    expect(pinnedCalls([...RUN, { tool: 'browse' }], true).map((c) => c.tool)).toEqual([
      'setStyle',
      'browse',
    ]);
    expect(pinnedCalls([{ tool: 'browse', ok: true }])).toEqual([]);
  });

  it('summarises the run: spinner while anything runs, warning if anything failed', () => {
    expect(runGlyph([{ tool: 'a', ok: true }])).toBe('check');
    expect(runGlyph(RUN)).toBe('warning');
    // In flight beats failed — the run is not over yet.
    expect(runGlyph(RUN, true)).toBe('warning');
    expect(runGlyph([{ tool: 'a' }], true)).toBe('spinner');
  });

  it('counts failures for the header', () => {
    expect(failedCount(RUN)).toBe(1);
    expect(failedCount([])).toBe(0);
  });

  // `pinnedCalls` is a filter and is allowed to return nothing; `collapsedCalls` is a render
  // list and is not. Keeping both is the point — the fallback must not smuggle a settled
  // success into the "pinned" set, or a green row would sit where only a live one belongs.
  it('falls back to the last call when a settled run has nothing to pin', () => {
    expect(collapsedCalls(SETTLED).map((c) => c.tool)).toEqual(['screenshot']);
    expect(pinnedCalls(SETTLED)).toEqual([]);
  });

  it('prefers the pinned rows whenever there are any', () => {
    expect(collapsedCalls(RUN).map((c) => c.tool)).toEqual(['setStyle']);
    expect(collapsedCalls([...RUN, { tool: 'browse' }], true).map((c) => c.tool)).toEqual([
      'setStyle',
      'browse',
    ]);
  });

  it('shows nothing only when there is nothing — a run with calls always yields a row', () => {
    expect(collapsedCalls([])).toEqual([]);
    for (const call of [{ tool: 'a', ok: true }, { tool: 'a', ok: false }, { tool: 'a' }]) {
      expect(collapsedCalls([call], false).length).toBeGreaterThan(0);
      expect(collapsedCalls([call], true).length).toBeGreaterThan(0);
    }
  });

  it('hides the successful calls but never the failure', () => {
    render(() => <ToolCallList calls={RUN} />);

    // Collapsed: one row on screen, and it is the one that failed.
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('no element matches #gone')).toBeInTheDocument();
    expect(screen.queryByText('extractIdentity')).not.toBeInTheDocument();

    // The header says what is behind the fold without opening it.
    const header = runHeader();
    expect(header).toHaveTextContent('4 actions');
    expect(header).toHaveTextContent('1 failed');

    fireEvent.click(header);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  // ── Regression: the group must not empty itself ──────────────────────────────────────────
  it('keeps the last call on screen when a run settles with everything successful', () => {
    render(() => <ToolCallList calls={SETTLED} />);

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]?.querySelector('.dz-tool-chip__name')).toHaveTextContent('screenshot');

    // Still collapsed: the other two are behind the fold, and the header still counts them.
    expect(screen.queryByText('pageFacts')).not.toBeInTheDocument();
    expect(runHeader()).toHaveTextContent('3 actions');

    expandRun();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  // The reported sequence, played through: rows on screen while streaming, then the results
  // land and streaming stops. The list must not go blank on that transition.
  it('does not empty itself when a streaming run settles under the reader', () => {
    const [calls, setCalls] = createSignal<ToolCallView[]>([
      { tool: 'pageFacts', kind: 'info' },
      { tool: 'describe', kind: 'read' },
      { tool: 'screenshot', kind: 'read' },
    ]);
    const [streaming, setStreaming] = createSignal(true);

    render(() => <ToolCallList calls={calls()} streaming={streaming()} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    setCalls(SETTLED);
    setStreaming(false);

    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.getByText('screenshot')).toBeInTheDocument();
  });
});

// ── Row noise ──────────────────────────────────────────────────────────────────────────────
// A settled row read "screenshot read done" — of which only the tool name told the reader
// anything. The kind badge and the outcome word are now visually-hidden (ToolChip.scss,
// ToolCallList.scss); both stay in the tree, because a glyph and a border colour are not a
// distinction to a screen reader (WCAG 1.4.1). jsdom loads no stylesheet, so what is pinned
// here is the markup contract the stylesheet hangs off: the text is present, under the classes
// that hide it.
describe('row chrome', () => {
  it('keeps the kind and the outcome word in the tree, under the classes that hide them', () => {
    render(() => <ToolCallList calls={[{ tool: 'screenshot', kind: 'read', ok: true }]} />);

    const [item] = screen.getAllByRole('listitem');
    if (!item) throw new Error('expected one rendered call');

    expect(item.querySelector('.dz-tool-chip__kind')).toHaveTextContent('read');
    expect(item.querySelector('.dz-tool-call-list__status')).toHaveTextContent('done');
    // The tool name is not one of the hidden bits — it is the row.
    expect(item.querySelector('.dz-tool-chip__name')).toHaveTextContent('screenshot');
  });

  it('still tells a failure apart from a success without either hidden word', () => {
    render(() => (
      <ToolCallList
        calls={[{ tool: 'setText', selector: '#gone', ok: false, error: 'no element matches' }]}
      />
    ));

    const [item] = screen.getAllByRole('listitem');
    expect(item).toHaveAttribute('data-status', 'failed');
    expect(item?.querySelector('.dz-tool-chip')).toHaveClass('dz-tool-chip--error');
    // The reason is visible prose, not a hidden label — a failure is the one row that shouts.
    expect(item?.querySelector('.dz-tool-call-list__error')).toHaveTextContent(
      'no element matches',
    );
  });
});
