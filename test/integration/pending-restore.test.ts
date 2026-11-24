import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionTools } from '@/agent/tools/session';
import { createPendingMutations, type PendingMutations } from '@/changeset/pending-mutations';
import {
  createPendingMutationsPersister,
  PENDING_PERSIST_DEBOUNCE_MS,
} from '@/changeset/pending-persist';
import { ChangesetStore, type SessionStorageArea } from '@/changeset/store';
import { emptyChangeset } from '@/shared/changeset';
import type { MutationEvent, SwToPanel } from '@/shared/messages';

// Integration (#148 item 3): the pending-mutations buffer survives an SW eviction. Wired exactly
// the way background.ts does it — `createPendingMutations({ onChange })` bound to the
// `chrome.storage.session` persister, hydration via `loadAll()` + `seed()` — but against an
// in-memory SessionStorageArea, and "eviction" = throwing the worker's in-memory instances away
// and building fresh ones over the SAME storage (the exact thing Chrome does to the SW).
// background.ts itself can't be imported under Vitest (WXT `#imports`), so the wiring is
// reproduced 1:1, the approach of changeset-record.test.ts / conversation-new.test.ts.
//
// The contract under test, end to end:
//   • A turn's buffered recorder events written before eviction are drained by the RESUMED
//     turn's REAL `recordEdit` (createSessionTools) and fold into the durable Edit — the
//     pre-#148 behavior was an empty drain and a model-values-only edit.
//   • The cap-drop counter survives too (the loss marker lands on the resumed edit's intent).
//   • nav-clear/tab-close (`clear`) deletes the mirror key, so a woken worker seeds nothing —
//     a dead document's ground truth can never fold into the new page's changeset.
//   • Live events that arrive before hydration beat the mirror (seed stands down).

const TAB = 42;
const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const URL = 'http://localhost:3000/pricing';

let clock = 0;
const ev = (selectorValue: string, extra: Partial<MutationEvent> = {}): MutationEvent => {
  clock += 1;
  return {
    kind: 'setStyle',
    selector: { value: selectorValue, strategy: 'id', fragile: false },
    before: '',
    after: '',
    ts: clock,
    ...extra,
  };
};

function fakeSessionArea() {
  const store = new Map<string, unknown>();
  const area: SessionStorageArea = {
    get: (keys) => {
      const names = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (store.has(name)) out[name] = store.get(name);
      return Promise.resolve(out);
    },
    set: (items) => {
      // Structured-clone stand-in: chrome.storage round-trips JSON-safe values, never references.
      for (const [k, v] of Object.entries(items)) store.set(k, JSON.parse(JSON.stringify(v)));
      return Promise.resolve();
    },
    remove: (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      return Promise.resolve();
    },
  };
  return { store, area };
}

/** One "service worker": the buffer + persister wired the way background.ts wires them, plus the
 *  boot hydration (`pendingReady`). */
async function bootWorker(
  area: SessionStorageArea,
  opts: { preHydrationEvents?: MutationEvent[] } = {},
): Promise<PendingMutations> {
  const persister = createPendingMutationsPersister(area);
  const buffer = createPendingMutations({
    cap: 3,
    onChange: (tabId, snapshot, kind) => persister.save(tabId, snapshot, kind),
  });
  // Events racing hydration append first in background.ts only when the ready gate has already
  // resolved; this option models the OTHER interleaving the seed guard exists for.
  for (const event of opts.preHydrationEvents ?? []) buffer.append(TAB, event);
  const restored = await persister.loadAll();
  for (const [tabId, snapshot] of restored) buffer.seed(tabId, snapshot);
  return buffer;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pending buffer persistence across SW eviction (#148 item 3)', () => {
  it('a resumed turn’s recordEdit drains the restored ground truth into the durable Edit', async () => {
    const { area } = fakeSessionArea();
    const first = await bootWorker(area);
    first.append(
      TAB,
      ev('#cta', {
        styleChanges: [
          { prop: 'background-color', before: 'rgb(0,0,0)', after: 'rgb(249,115,22)' },
        ],
      }),
    );
    first.append(
      TAB,
      ev('#cta', { kind: 'setText', textChange: { before: 'Buy', after: 'Buy now' } }),
    );
    await vi.advanceTimersByTimeAsync(PENDING_PERSIST_DEBOUNCE_MS); // trailing append lands

    // EVICTION: the worker (and its in-memory buffer) dies; a fresh one hydrates from storage.
    const resumed = await bootWorker(area);

    // The resumed turn's session tools, wired like background.ts's user-message case.
    const store = new ChangesetStore(emptyChangeset(URL, '2026-08-15T00:00:00Z', SESSION_ID));
    const emitted: SwToPanel[] = [];
    const tools = createSessionTools({
      store,
      persist: () => {},
      emit: (e) => emitted.push(e),
      drainRecorderEvents: (selectorValue) => resumed.drain(TAB, selectorValue),
    });
    const execute = tools.recordEdit.execute as unknown as (
      input: unknown,
      opts: Record<string, unknown>,
    ) => Promise<unknown>;
    await execute(
      {
        intent: 'Brand the CTA',
        selector: { value: '#cta', strategy: 'id', fragile: false },
        changes: [],
        attrs: [],
        classes: [],
        frameworkHints: [],
      },
      {},
    );

    const recorded = store.current.edits[0];
    // Ground truth folded from the RESTORED events — not the model's empty statement.
    expect(recorded?.changes).toEqual([
      { prop: 'background-color', before: 'rgb(0,0,0)', after: 'rgb(249,115,22)' },
    ]);
    expect(recorded?.text).toEqual({ before: 'Buy', after: 'Buy now' });
    expect(resumed.peekGroups(TAB)).toEqual([]); // drained, nothing left to auto-finalize
  });

  it('the cap-drop counter survives eviction and surfaces on the resumed edit', async () => {
    const { area } = fakeSessionArea();
    const first = await bootWorker(area);
    for (const v of ['#a', '#b', '#c', '#d']) first.append(TAB, ev(v)); // cap 3 ⇒ 1 dropped
    await vi.advanceTimersByTimeAsync(PENDING_PERSIST_DEBOUNCE_MS);

    const resumed = await bootWorker(area);
    expect(resumed.droppedCount(TAB)).toBe(1);
    const { dropped } = resumed.drain(TAB, '#b');
    expect(dropped).toBe(1);
  });

  it('a drain’s write-through beats eviction — folded events never resurrect', async () => {
    const { area, store } = fakeSessionArea();
    const first = await bootWorker(area);
    first.append(TAB, ev('#cta'));
    first.append(TAB, ev('#hero'));
    await vi.advanceTimersByTimeAsync(PENDING_PERSIST_DEBOUNCE_MS);
    first.drain(TAB, '#cta'); // recordEdit folded #cta; the shrink writes through immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(store.size).toBe(1);

    const resumed = await bootWorker(area);
    const groups = resumed.peekGroups(TAB);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.selector.value).toBe('#hero'); // #cta stays folded, not double-recorded
  });

  it('clear (nav-clear / tab close) deletes the mirror — a woken worker seeds nothing', async () => {
    const { area, store } = fakeSessionArea();
    const first = await bootWorker(area);
    first.append(TAB, ev('#cta'));
    await vi.advanceTimersByTimeAsync(PENDING_PERSIST_DEBOUNCE_MS);
    expect(store.size).toBe(1);
    first.clear(TAB); // the navigation wiped the tab's buffer
    await vi.advanceTimersByTimeAsync(0);
    expect(store.size).toBe(0);

    const resumed = await bootWorker(area);
    expect(resumed.peekGroups(TAB)).toEqual([]);
    expect(resumed.drain(TAB, '#cta').events).toEqual([]);
  });

  it('live events that beat hydration win over the mirror (seed stands down)', async () => {
    const { area } = fakeSessionArea();
    const first = await bootWorker(area);
    first.append(TAB, ev('#stale'));
    await vi.advanceTimersByTimeAsync(PENDING_PERSIST_DEBOUNCE_MS);

    const resumed = await bootWorker(area, { preHydrationEvents: [ev('#live')] });
    const groups = resumed.peekGroups(TAB);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.selector.value).toBe('#live');
  });
});
