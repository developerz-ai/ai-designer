// NavMenu is the panel's navigation — the wordmark disclosure that replaced the five-across tab
// strip. What matters here is contract, not pixels: the five accessible names are matched by
// `getByRole('button', { name: … })` across the whole e2e suite, the active surface has to be
// announced (not just tinted), and none of these may submit a form they happen to sit in.
//
// jsdom (verified, not assumed) has NO `showPopover`/`hidePopover` — but it DOES apply the UA
// stylesheet's `display: none` to a closed `[popover]`. Two consequences, both load-bearing:
//   • NavMenu must be attribute-driven — an imperative `hidePopover()` throws in this environment.
//   • The rows are correctly absent from the accessibility tree while closed, and there is no way
//     to open the menu here. So row queries pass `{ hidden: true }`, and the one test that omits
//     it is asserting exactly that invisibility.
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { NavMenu, roomName } from '@/entrypoints/sidepanel/components/NavMenu';
import { setTab, type Tab, tab } from '@/entrypoints/sidepanel/stores/nav';

// The changeset store, faked: NavMenu reads it directly for the Diff row's edit count (zero
// props, the same arrangement ModelPicker uses for `stores/settings`), and the real one opens a
// `chrome.runtime` port on init. The signal is genuine so a count appearing is a real reactive
// update, not a static render.
vi.mock('@/entrypoints/sidepanel/stores/changeset', async () => {
  const { createSignal: signal } = await import('solid-js');
  const [changeset, setChangeset] = signal<{ edits: unknown[] } | null>(null);
  // `initChangesetStore` only SUBSCRIBES; `refreshChangeset` is what actually fetches, and
  // NavMenu calls both so the count is right on panel open rather than only after the next edit.
  return {
    changeset,
    initChangesetStore: vi.fn(),
    refreshChangeset: vi.fn(async () => {}),
    __setChangeset: setChangeset,
  };
});

const NAMES = ['Chat', 'Diff', 'History', 'MCP', 'Settings'] as const;
const IDS: Tab[] = ['chat', 'diff', 'history', 'mcp', 'settings'];

/** The nav store is module-level state shared by every test in this file — set it explicitly so
 *  execution order can never decide an assertion. */
function renderNav(active: Tab = 'chat') {
  setTab(active);
  return render(() => <NavMenu />);
}

/** A menu row. `hidden: true` because the closed popover is `display: none` — see the file
 *  header; without it every row query fails for the right reason at the wrong time. */
function row(name: string): HTMLElement {
  return screen.getByRole('button', { name, hidden: true });
}

describe('NavMenu', () => {
  it('renders the wordmark trigger plus exactly the five surfaces, by accessible name', () => {
    renderNav();

    // Trigger + five rows. The trigger's name is the visible wordmark, which is what every spec
    // clicks to reach a room.
    expect(screen.getByRole('button', { name: 'Designer' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { hidden: true })).toHaveLength(NAMES.length + 1);
    for (const name of NAMES) {
      expect(row(name)).toBeInTheDocument();
    }
  });

  it('keeps the rows out of the accessibility tree while the menu is closed', () => {
    renderNav();

    // The whole point of a disclosure: at rest the panel exposes ONE navigation control, not
    // five. Chat is the app, and the header should not read as a five-way decision.
    for (const name of NAMES) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Designer' })).toBeVisible();
  });

  it('sets the matching surface for every row clicked', () => {
    renderNav();

    NAMES.forEach((name, i) => {
      fireEvent.click(row(name));
      expect(tab()).toBe(IDS[i]);
    });
  });

  it('marks the active surface — and only it — with aria-current="page"', () => {
    renderNav('history');

    expect(row('History')).toHaveAttribute('aria-current', 'page');
    const current = screen
      .getAllByRole('button', { hidden: true })
      .filter((b) => b.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
  });

  it('moves aria-current when the surface changes', () => {
    renderNav('chat');

    expect(row('Chat')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(row('Settings'));
    expect(row('Chat')).not.toHaveAttribute('aria-current');
    expect(row('Settings')).toHaveAttribute('aria-current', 'page');
  });

  it('declares every control as type="button" so none can submit a form', () => {
    renderNav();

    for (const button of screen.getAllByRole('button', { hidden: true })) {
      expect(button).toHaveAttribute('type', 'button');
    }
  });

  it('declares the trigger collapsed until the popover reports itself open', () => {
    renderNav();

    // Explicit, not inferred from `popovertarget`: the implicit expanded mapping is a Chrome
    // behaviour and this also builds for Firefox. jsdom never fires `toggle`, so it stays false.
    expect(screen.getByRole('button', { name: 'Designer' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('closes the popover from the row itself, by attribute rather than by script', () => {
    renderNav();

    // Load-bearing: `hidePopover()` does not exist in jsdom, so a row that closed the menu
    // imperatively would throw in every unit test that clicks one.
    expect(row('Settings')).toHaveAttribute('popovertarget', 'dz-nav-menu');
    expect(row('Settings')).toHaveAttribute('popovertargetaction', 'hide');
  });

  it('puts the edit count in the Diff row as real text, not an aria-hidden badge', async () => {
    const store = (await import('@/entrypoints/sidepanel/stores/changeset')) as unknown as {
      __setChangeset: (value: { edits: unknown[] } | null) => void;
    };

    store.__setChangeset(null);
    renderNav();
    expect(row('Diff')).toHaveTextContent('Diff');

    store.__setChangeset({ edits: [{}, {}, {}, {}] });
    // A PREFIX match here, and the difference matters: testing-library matches an accessible
    // name as a whole string, Playwright as a case-insensitive SUBSTRING. So the name becoming
    // "Diff 4 edits" breaks `getByRole({ name: 'Diff' })` in this file while every
    // `getByRole('button', { name: 'Diff' })` in the e2e suite keeps resolving. Any future spec
    // that adds `exact: true` to a Diff locator is the thing that would break.
    const diff = screen.getByRole('button', { name: /^Diff/, hidden: true });
    expect(diff).toHaveTextContent('4 edits');

    store.__setChangeset(null);
  });

  it('names a room the same way the menu row does', () => {
    expect(roomName('settings')).toBe('Settings');
    expect(roomName('diff')).toBe('Diff');
  });
});
