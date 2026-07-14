import { beforeEach, describe, expect, it } from 'vitest';
import {
  EmulationRegistry,
  type EmulationTeardown,
  type SavedWindow,
} from '@/agent/emulation-registry';

// emulation-registry unit: the SW's device-emulation teardown bookkeeping persists to (and
// rehydrates from) an in-memory chrome.storage.session fake, reconciles emulation orphaned by an
// eviction on wake, and scopes teardown to the owning turn — no real chrome.debugger/windows (the
// raw teardown primitives are injected).

// Minimal in-memory chrome.storage.session (MV3 promise API), exposed for assertions.
function installChromeStorageSessionFake(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  const session = {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const names = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (store.has(name)) out[name] = store.get(name);
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [name, value] of Object.entries(items))
        store.set(name, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      return Promise.resolve();
    },
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { session } };
  return store;
}

function fakeTeardown() {
  const detached: number[] = [];
  const restored: SavedWindow[] = [];
  const teardown: EmulationTeardown = {
    detach: (tabId) => {
      detached.push(tabId);
      return Promise.resolve();
    },
    restoreWindow: (saved) => {
      restored.push(saved);
      return Promise.resolve();
    },
  };
  return { detached, restored, teardown };
}

let backing: Map<string, unknown>;
const KEY = 'emulation:state';

beforeEach(() => {
  backing = installChromeStorageSessionFake();
});

describe('EmulationRegistry: persistence', () => {
  it('records an attach + window resize and mirrors them to storage.session', async () => {
    const reg = new EmulationRegistry();
    await reg.recordAttach(7, 'turn-a');
    await reg.recordWindow(7, 'turn-a', { windowId: 1, width: 375, height: 667 });

    expect(reg.isAttached(7)).toBe(true);
    expect(reg.savedWindow(7)).toEqual({ windowId: 1, width: 375, height: 667 });
    expect(reg.owns(7, 'turn-a')).toBe(true);
    expect(backing.get(KEY)).toEqual({
      '7': {
        owner: 'turn-a',
        cdpAttached: true,
        savedWindow: { windowId: 1, width: 375, height: 667 },
      },
    });
  });

  it('hydrate rehydrates a persisted registry into a fresh instance', async () => {
    const first = new EmulationRegistry();
    await first.recordAttach(9, 'turn-x');

    const revived = new EmulationRegistry();
    expect(revived.isAttached(9)).toBe(false);
    await revived.hydrate();
    expect(revived.isAttached(9)).toBe(true);
    expect(revived.owns(9, 'turn-x')).toBe(true);
  });

  it('clearing both attach and window removes the persisted entry entirely', async () => {
    const reg = new EmulationRegistry();
    await reg.recordAttach(7, 'a');
    await reg.recordWindow(7, 'a', { windowId: 1 });
    await reg.clearAttach(7);
    expect(backing.has(KEY)).toBe(true); // window still held
    await reg.clearWindow(7);
    expect(reg.isAttached(7)).toBe(false);
    expect(reg.savedWindow(7)).toBeUndefined();
    expect(backing.has(KEY)).toBe(false); // fully cleared
  });
});

describe('EmulationRegistry: wake reconcile (orphaned by SW eviction)', () => {
  it('detaches the debugger + restores resized windows for every persisted entry, then clears', async () => {
    // A prior (evicted) SW life left emulation on two tabs.
    const first = new EmulationRegistry();
    await first.recordAttach(1, 'dead-turn');
    await first.recordWindow(2, 'dead-turn', { windowId: 5, width: 400, height: 800 });

    const revived = new EmulationRegistry();
    await revived.hydrate();
    const { detached, restored, teardown } = fakeTeardown();
    await revived.reconcile(teardown);

    expect(detached).toEqual([1]);
    expect(restored).toEqual([{ windowId: 5, width: 400, height: 800 }]);
    // Registry + storage are cleared so the reconcile can't run twice.
    expect(revived.isAttached(1)).toBe(false);
    expect(backing.has(KEY)).toBe(false);
  });

  it('is a no-op with nothing persisted', async () => {
    const reg = new EmulationRegistry();
    await reg.hydrate();
    const { detached, restored, teardown } = fakeTeardown();
    await reg.reconcile(teardown);
    expect(detached).toEqual([]);
    expect(restored).toEqual([]);
  });
});

describe('EmulationRegistry: owner-scoped teardown (concurrent same-tab turns)', () => {
  it('a newer turn taking emulation over flips ownership, so the superseded turn no longer owns it', async () => {
    const reg = new EmulationRegistry();
    // Turn A applies emulation on tab 3 …
    await reg.recordAttach(3, 'turn-a');
    expect(reg.owns(3, 'turn-a')).toBe(true);

    // … then a newer concurrent same-tab turn B takes it over (re-applies).
    await reg.recordAttach(3, 'turn-b');
    expect(reg.owns(3, 'turn-a')).toBe(false); // A must NOT tear B's emulation down
    expect(reg.owns(3, 'turn-b')).toBe(true);
  });
});
