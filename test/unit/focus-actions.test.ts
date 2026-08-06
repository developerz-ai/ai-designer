import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw } from '@/shared/messages';

// Composer's attach trigger / ContextChip's dismiss dispatch onto the focus store's
// startPicker/stopPicker — thin RPC wrappers around start-picker/stop-picker (mirrors the
// chrome-fake pattern in test/unit/settings-store.test.ts).

function installChromeFake(handle: (msg: PanelToSw) => unknown) {
  const sendMessage = vi.fn(async (msg: unknown) => handle(msg as PanelToSw));
  const connect = vi.fn(() => ({
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() },
  }));
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage, connect } };
  return { sendMessage };
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('focus store: startPicker/stopPicker', () => {
  it('startPicker dispatches start-picker', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/focus');

    await store.startPicker();

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'start-picker' }));
  });

  it.each([
    'startPicker',
    'stopPicker',
  ] as const)('%s surfaces a rejected RPC instead of rejecting into an unhandled rejection', async (action) => {
    // The SW is mid-restart: chrome answers "Receiving end does not exist". Unhandled, the
    // button silently does nothing and Sentry logs a crash.
    vi.resetModules();
    installChromeFake(() => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });
    const store = await import('@/entrypoints/sidepanel/stores/focus');

    await expect(store[action]()).resolves.toBeUndefined();
    expect(store.error()).toMatch(/Receiving end does not exist/);
  });

  it('stopPicker clears local state immediately and dispatches stop-picker', async () => {
    vi.resetModules();
    const { sendMessage } = installChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/focus');

    store.initFocusStore();
    await store.stopPicker();

    expect(store.selector()).toBeNull();
    expect(store.pickerActive()).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop-picker' }));
  });
});

// ── Detaching a reference ──────────────────────────────────────────────────────────────────
// `removeReference` is what a reference chip's × calls. The bug it exists to prevent: the picker
// owns the committed selection in the CONTENT world, and `multi-select-changed` is the only write
// path into `multiSelectors` — so forgetting a reference only in the panel was reverted by the
// picker's very next echo, and the agent was grounded on an element the user had explicitly
// detached. These tests drive the REAL push stream, so the store is populated the way the service
// worker actually populates it.

/** A chrome fake whose Port hands back its message listener, so a test can push a real
 *  `SwToPanel` into the store instead of reaching into module state. */
function installStreamingChromeFake(handle: (msg: PanelToSw) => unknown) {
  const sendMessage = vi.fn(async (msg: unknown) => handle(msg as PanelToSw));
  let push: ((raw: unknown) => void) | undefined;
  const connect = vi.fn(() => ({
    onMessage: {
      addListener: (fn: (raw: unknown) => void) => {
        push = fn;
      },
    },
    onDisconnect: { addListener: vi.fn() },
  }));
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage, connect } };
  return { sendMessage, push: (raw: unknown) => push?.(raw) };
}

const SEL = (value: string) => ({ value, strategy: 'id' as const, fragile: false });
// `focus.rect` is REQUIRED by the schema — `parseSwToPanel` silently drops a push carrying
// `rect: null`, which is a very quiet way for a test to assert nothing at all.
const RECT = { x: 0, y: 0, width: 10, height: 10 };

describe('focus store: removeReference', () => {
  it('orders the pin first, then the multi set — the numbering the chips and page boxes share', async () => {
    vi.resetModules();
    const store = await import('@/entrypoints/sidepanel/stores/focus');
    const pin = SEL('#pin');
    expect(store.orderedReferences(pin, [SEL('#a'), SEL('#b')])).toEqual([
      pin,
      SEL('#a'),
      SEL('#b'),
    ]);
    expect(store.orderedReferences(null, [SEL('#a')])).toEqual([SEL('#a')]);
    expect(store.orderedReferences(null, [])).toEqual([]);
  });

  it('splices the right entry out of the multi set and tells the PAGE to drop it too', async () => {
    vi.resetModules();
    const { sendMessage, push } = installStreamingChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/focus');
    store.initFocusStore();

    push({ type: 'focus-multi', selectors: [SEL('#a'), SEL('#b'), SEL('#c')] });
    expect(store.multiSelectors().map((s) => s.value)).toEqual(['#a', '#b', '#c']);

    store.removeReference(1); // the middle chip
    await Promise.resolve();

    expect(store.multiSelectors().map((s) => s.value)).toEqual(['#a', '#c']);
    // The round trip is the fix: without it the picker's next echo brings '#b' straight back.
    expect(sendMessage).toHaveBeenCalledWith({ type: 'deselect-element', value: '#b' });
  });

  it('maps index 0 onto the PIN when one is attached, not onto the first multi entry', async () => {
    vi.resetModules();
    const { sendMessage, push } = installStreamingChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/focus');
    store.initFocusStore();

    push({ type: 'focus', selector: SEL('#pin'), xpath: '/html/body/a', rect: RECT });
    push({ type: 'focus-multi', selectors: [SEL('#a')] });

    store.removeReference(0);
    await Promise.resolve();

    expect(store.selector()).toBeNull();
    expect(store.multiSelectors().map((s) => s.value)).toEqual(['#a']); // untouched
    expect(sendMessage).toHaveBeenCalledWith({ type: 'deselect-element', value: '#pin' });
  });

  it('offsets by the pin, so index 1 with a pin attached removes the FIRST multi entry', async () => {
    vi.resetModules();
    const { sendMessage, push } = installStreamingChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/focus');
    store.initFocusStore();

    push({ type: 'focus', selector: SEL('#pin'), rect: RECT });
    push({ type: 'focus-multi', selectors: [SEL('#a'), SEL('#b')] });

    store.removeReference(1);
    await Promise.resolve();

    expect(store.selector()?.value).toBe('#pin'); // the pin survives
    expect(store.multiSelectors().map((s) => s.value)).toEqual(['#b']);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'deselect-element', value: '#a' });
  });

  it('is a no-op for an index that names nothing — no state change, no RPC', async () => {
    vi.resetModules();
    const { sendMessage, push } = installStreamingChromeFake(() => ({ ok: true }));
    const store = await import('@/entrypoints/sidepanel/stores/focus');
    store.initFocusStore();

    push({ type: 'focus-multi', selectors: [SEL('#a')] });
    store.removeReference(7);
    await Promise.resolve();

    expect(store.multiSelectors().map((s) => s.value)).toEqual(['#a']);
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'deselect-element' }),
    );
  });

  it('surfaces a failed deselect instead of rejecting into an unhandled rejection', async () => {
    vi.resetModules();
    const { push } = installStreamingChromeFake(() => {
      throw new Error('Receiving end does not exist');
    });
    const store = await import('@/entrypoints/sidepanel/stores/focus');
    store.initFocusStore();
    push({ type: 'focus-multi', selectors: [SEL('#a')] });

    // The chip is already gone locally, so a dead content script degrades to the old
    // panel-local behaviour rather than throwing or blocking the dismiss.
    expect(() => store.removeReference(0)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.multiSelectors()).toEqual([]);
    expect(store.error()).toMatch(/Receiving end/);
  });
});
