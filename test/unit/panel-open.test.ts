import { describe, expect, it, vi } from 'vitest';
import { type PanelHost, wirePanelOpen } from '@/agent/panel-open';

// The per-browser toolbar→panel adapter (#180). What has to hold: Chrome gets the native
// openPanelOnActionClick toggle and NO onClicked listener (registering one suppresses that
// toggle); Firefox gets the browserAction→sidebarAction handler with `toggle` preferred and the
// call made synchronously inside the click handler (an await first voids the user gesture); a
// runtime with neither surface wires nothing and does not throw — SW boot must survive it.

function fakeChrome(): { host: PanelHost; setPanelBehavior: ReturnType<typeof vi.fn> } {
  const setPanelBehavior = vi.fn().mockResolvedValue(undefined);
  return { host: { chrome: { sidePanel: { setPanelBehavior } } }, setPanelBehavior };
}

function fakeFirefox(sidebar: { toggle?: () => Promise<void>; open?: () => Promise<void> }): {
  host: PanelHost;
  click: () => void;
  listeners: Array<() => void>;
} {
  const listeners: Array<() => void> = [];
  return {
    host: {
      chrome: { browserAction: { onClicked: { addListener: (fn) => listeners.push(fn) } } },
      browser: { sidebarAction: sidebar },
    },
    click: () => {
      for (const fn of listeners) fn();
    },
    listeners,
  };
}

describe('wirePanelOpen', () => {
  it('Chrome: asserts openPanelOnActionClick and registers no click handler', () => {
    const { host, setPanelBehavior } = fakeChrome();
    expect(wirePanelOpen(host)).toBe('sidePanel');
    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
  });

  it('Chrome: a rejected setPanelBehavior is swallowed, not an unhandled rejection', async () => {
    const setPanelBehavior = vi.fn().mockRejectedValue(new Error('nope'));
    expect(wirePanelOpen({ chrome: { sidePanel: { setPanelBehavior } } })).toBe('sidePanel');
    await Promise.resolve(); // let the rejection settle through the .catch
  });

  it('Firefox: the toolbar click toggles the sidebar synchronously in the gesture', () => {
    const toggle = vi.fn().mockResolvedValue(undefined);
    const { host, click } = fakeFirefox({ toggle });
    expect(wirePanelOpen(host)).toBe('sidebarAction');
    expect(toggle).not.toHaveBeenCalled(); // wiring alone must not open anything
    click();
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('Firefox: falls back to open() on a runtime without toggle()', () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const { host, click } = fakeFirefox({ open });
    expect(wirePanelOpen(host)).toBe('sidebarAction');
    click();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('Firefox: a rejected toggle is swallowed inside the handler', () => {
    const toggle = vi.fn().mockRejectedValue(new Error('sidebar denied'));
    const { host, click } = fakeFirefox({ toggle });
    wirePanelOpen(host);
    expect(() => click()).not.toThrow();
  });

  it('neither surface: wires nothing and reports it instead of throwing', () => {
    expect(wirePanelOpen({})).toBe('none');
    expect(wirePanelOpen({ chrome: {} })).toBe('none');
    // A sidebar with no way to click it (no browserAction) must also stand down.
    expect(wirePanelOpen({ browser: { sidebarAction: { toggle: async () => {} } } })).toBe('none');
  });
});
