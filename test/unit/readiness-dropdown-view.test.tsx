// The mounted readiness/session pill. `readiness-dropdown.test.ts` covers the pure three-state
// `sessionButton` mapping; this covers what only a mount shows — that the expanded panel dismisses
// on an outside press, and that the pill still toggles.
//
// The stores are mocked because the component reads them directly (zero props but `onNavigate`)
// and the real ones talk to `chrome.runtime`. Each factory builds the genuine Solid primitive it
// stands in for, so the component re-renders exactly as it would in the panel.
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadinessDropdown } from '@/entrypoints/sidepanel/components/ReadinessDropdown';

vi.mock('@/entrypoints/sidepanel/stores/readiness', async () => {
  const { createSignal } = await import('solid-js');
  const [state] = createSignal({
    ready: true,
    provider: 'ok',
    model: 'ok',
    apiKey: 'ok',
    hostPermission: 'granted',
    pageAccess: 'granted',
    mcp: { connected: 1, total: 1 },
  });
  const [loading] = createSignal(false);
  const [error] = createSignal<string | null>(null);
  return { state, loading, error, initReadinessStore: vi.fn(), grantPageAccess: vi.fn() };
});

vi.mock('@/entrypoints/sidepanel/stores/session', async () => {
  const { createSignal } = await import('solid-js');
  const [sessionState] = createSignal('running');
  const [error] = createSignal<string | null>(null);
  return {
    sessionState,
    error,
    initSessionStore: vi.fn(),
    startSession: vi.fn(async () => {}),
    stopSession: vi.fn(async () => {}),
  };
});

vi.mock('@/entrypoints/sidepanel/stores/overlay', async () => {
  const { createSignal } = await import('solid-js');
  const [enabled] = createSignal(false);
  const [error] = createSignal<string | null>(null);
  return { enabled, error, initOverlayStore: vi.fn(), setOverlayEnabled: vi.fn(async () => {}) };
});

/** The primitive listens on `pointerdown` in the capture phase — a `click` would be too late and
 *  would not reproduce the bug. */
function press(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
}

function pill(): HTMLElement {
  return screen.getByRole('button', { name: /Running/ });
}

function panelOpen(): boolean {
  return pill().getAttribute('aria-expanded') === 'true';
}

let outside: HTMLButtonElement;

beforeEach(() => {
  outside = document.createElement('button');
  outside.textContent = 'elsewhere';
  document.body.append(outside);
  return () => outside.remove();
});

describe('ReadinessDropdown — light dismiss', () => {
  // The reported bug: the menu stayed up over the panel until its own pill was pressed again.
  it('closes when a press lands outside it', () => {
    render(() => <ReadinessDropdown onNavigate={vi.fn()} />);
    fireEvent.click(pill());
    expect(panelOpen()).toBe(true);

    press(outside);

    expect(panelOpen()).toBe(false);
  });

  // The classic way this fix goes wrong: an outside-press handler that also fires on the
  // trigger's own press closes and immediately reopens, and the button looks dead.
  it('still toggles from the pill itself — never close-then-reopen', () => {
    render(() => <ReadinessDropdown onNavigate={vi.fn()} />);

    press(pill());
    fireEvent.click(pill());
    expect(panelOpen()).toBe(true);

    press(pill());
    fireEvent.click(pill());
    expect(panelOpen()).toBe(false);
  });

  it('ignores presses inside the expanded panel', () => {
    render(() => <ReadinessDropdown onNavigate={vi.fn()} />);
    fireEvent.click(pill());

    press(screen.getByRole('switch'));

    expect(panelOpen()).toBe(true);
  });
});
