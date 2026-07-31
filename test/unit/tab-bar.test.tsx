// TabBar is the panel's surface switcher, extracted out of App.tsx (#165). What matters
// here is contract, not pixels: the five accessible names are matched by
// `getByRole('button', { name: … })` across eight e2e specs, the active surface has to be
// announced (not just tinted), and none of these may submit a form they happen to sit in.
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { type Tab, TabBar } from '@/entrypoints/sidepanel/components/TabBar';

const NAMES = ['Chat', 'Diff', 'MCP', 'History', 'Settings'] as const;
const IDS: Tab[] = ['chat', 'diff', 'mcp', 'history', 'settings'];

describe('TabBar', () => {
  it('renders exactly the five surfaces, by accessible name', () => {
    render(() => <TabBar active="chat" onSelect={() => {}} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(5);
    for (const name of NAMES) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('dispatches the matching tab id for every tab clicked', () => {
    const onSelect = vi.fn();
    render(() => <TabBar active="chat" onSelect={onSelect} />);

    NAMES.forEach((name, i) => {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(onSelect).toHaveBeenNthCalledWith(i + 1, IDS[i]);
    });
    expect(onSelect).toHaveBeenCalledTimes(NAMES.length);
  });

  it('marks the active tab — and only it — with aria-current="page"', () => {
    render(() => <TabBar active="history" onSelect={() => {}} />);

    expect(screen.getByRole('button', { name: 'History' })).toHaveAttribute('aria-current', 'page');
    const current = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
  });

  it('moves aria-current when the active prop changes', () => {
    const [active, setActive] = createSignal<Tab>('chat');
    render(() => <TabBar active={active()} onSelect={setActive} />);

    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('button', { name: 'Chat' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('declares every tab as type="button" so none can submit a form', () => {
    render(() => <TabBar active="chat" onSelect={() => {}} />);

    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAttribute('type', 'button');
    }
  });
});
