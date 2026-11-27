import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw, StableSelector, SwToPanel } from '@/shared/messages';

// A picked element belongs to the page it was picked on. `focus`/`focus-multi` pushes carry no
// tab, so the store records the active tab when they arrive and hides them on any other tab —
// before this, a pin made on tab A went out as the referent of "this" for a message on tab B.

const PIN: StableSelector = { strategy: 'id', value: '#cta', fragile: false };
const MULTI: StableSelector = { strategy: 'aria', value: '.card', fragile: false };
const RECT = { x: 0, y: 0, width: 10, height: 10 };

let emit: (m: SwToPanel) => void = () => {};
let activate: (tabId: number, windowId?: number) => void = () => {};

function installChromeFake(reply: (m: PanelToSw) => unknown = () => ({ ok: true })): void {
  const listeners: Array<(m: unknown) => void> = [];
  const activated: Array<(info: { tabId: number; windowId: number }) => void> = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: vi.fn(async (m: unknown) => reply(m as PanelToSw)),
      connect: () => ({
        onMessage: { addListener: (f: (m: unknown) => void) => void listeners.push(f) },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
      }),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 1, windowId: 9 }]),
      onActivated: {
        addListener: (f: (info: { tabId: number; windowId: number }) => void) =>
          void activated.push(f),
      },
    },
  };
  emit = (m) => {
    for (const f of listeners) f(m);
  };
  activate = (tabId, windowId = 9) => {
    for (const f of activated) f({ tabId, windowId });
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

async function storeOnTab1() {
  installChromeFake();
  const focus = await import('@/entrypoints/sidepanel/stores/focus');
  focus.initFocusStore();
  await flush(); // the initial active-tab query
  emit({ type: 'focus', selector: PIN, xpath: '/html/body/a', rect: RECT });
  emit({ type: 'focus-multi', selectors: [MULTI] });
  return focus;
}

describe('focus references are tab-scoped', () => {
  it('hides tab A references on tab B and brings them back on A', async () => {
    const focus = await storeOnTab1();
    expect(focus.selector()).toEqual(PIN);

    activate(2);
    expect(focus.selector()).toBeNull();
    expect(focus.xpath()).toBeNull();
    expect(focus.multiSelectors()).toEqual([]);

    activate(1);
    expect(focus.selector()).toEqual(PIN);
    expect(focus.multiSelectors()).toEqual([MULTI]);
  });

  it('a picker-state push on another tab does not erase the hidden references', async () => {
    const focus = await storeOnTab1();
    activate(2);
    emit({ type: 'picker-state', active: false });

    activate(1);
    expect(focus.selector()).toEqual(PIN);
  });

  it('a pick on tab B starts from B, never resurfacing A references beside it', async () => {
    const focus = await storeOnTab1();
    activate(2);
    const other: StableSelector = { strategy: 'id', value: '#b', fragile: false };
    emit({ type: 'focus', selector: other, rect: RECT });

    expect(focus.selector()).toEqual(other);
    expect(focus.multiSelectors()).toEqual([]);
  });

  it('ignores tab activations in other windows', async () => {
    const focus = await storeOnTab1();
    activate(5, 42);
    expect(focus.selector()).toEqual(PIN);
  });
});

describe('picker RPCs check ok', () => {
  it.each(['startPicker', 'stopPicker', 'disarmPicker'] as const)(
    '%s surfaces { ok: false } from a tab with no content script',
    async (action) => {
      installChromeFake(() => ({ ok: false }));
      const focus = await import('@/entrypoints/sidepanel/stores/focus');

      await focus[action]();

      expect(focus.error()).toBeTruthy();
    },
  );
});
