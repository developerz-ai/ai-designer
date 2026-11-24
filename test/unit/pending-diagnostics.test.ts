import { describe, expect, it, vi } from 'vitest';
import {
  createPendingDiagnostics,
  type PendingDiagnosticsSnapshot,
} from '@/changeset/pending-diagnostics';
import { createPendingDiagnosticsPersister } from '@/changeset/pending-diagnostics-persist';
import type { SessionStorageArea } from '@/changeset/store';
import type { CollectorSignal } from '@/shared/diagnostics';

// pending-diagnostics.ts unit: the SW's per-tab FIFO buffer of collector diagnostics signals.
// append buffers, drain returns + clears + resets the drop counter, the cap drops the oldest
// and counts them, seed restores a persisted snapshot into an untouched tab, and onChange
// mirrors each state change so chrome.storage.session round-trips. Pure logic, no chrome.*,
// no clock (signals carry their own ts).

const consoleSig = (text: string, ts: number): CollectorSignal => ({
  kind: 'console',
  level: 'error',
  text,
  ts,
});

const networkSig = (url: string, ts: number): CollectorSignal => ({
  kind: 'network',
  method: 'GET',
  url,
  ok: false,
  status: 500,
  ts,
});

describe('createPendingDiagnostics', () => {
  it('persists real buffered signals across instances and removes them on drain', async () => {
    vi.useFakeTimers();
    try {
      const data: Record<string, unknown> = {};
      const area: SessionStorageArea = {
        get: async () => ({ ...data }),
        set: async (items) => {
          Object.assign(data, items);
        },
        remove: async (key) => {
          for (const item of Array.isArray(key) ? key : [key]) delete data[item];
        },
      };
      const persister = createPendingDiagnosticsPersister(area, 10);
      const source = createPendingDiagnostics({ cap: 1, onChange: persister.save });
      source.append(7, consoleSig('dropped', 1));
      source.append(7, networkSig('https://a/x', 2));
      await vi.advanceTimersByTimeAsync(10);
      const freshPersister = createPendingDiagnosticsPersister(area, 10);
      const restored = createPendingDiagnostics({ onChange: freshPersister.save });
      const snapshot = (await freshPersister.loadAll()).get(7);
      expect(snapshot).toEqual({ signals: [networkSig('https://a/x', 2)], dropped: 1 });
      if (!snapshot) throw new Error('missing snapshot');
      restored.seed(7, snapshot);
      expect(restored.drain(7)).toEqual(snapshot);
      expect((await freshPersister.loadAll()).has(7)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('drain of an empty tab returns empty and a zero drop count', () => {
    const buf = createPendingDiagnostics();
    expect(buf.drain(1)).toEqual({ signals: [], dropped: 0 });
    expect(buf.droppedCount(1)).toBe(0);
    expect(buf.peekGroups(1)).toEqual([]);
  });

  it('removes only reported signals, retaining those appended during report generation', () => {
    const buf = createPendingDiagnostics();
    const first = consoleSig('first', 1);
    const later = consoleSig('later', 2);
    buf.append(1, first);
    const report = buf.peekGroups(1).flatMap((group) => group.signals);
    buf.append(1, later);
    buf.removeReported(1, report);
    expect(buf.drain(1).signals).toEqual([later]);
  });

  it('append buffers per tab and drain returns them in arrival order, then resets', () => {
    const buf = createPendingDiagnostics();
    buf.append(1, consoleSig('one', 1));
    buf.append(1, consoleSig('two', 2));
    buf.append(2, consoleSig('other tab', 3));

    expect(buf.drain(1)).toEqual({
      signals: [consoleSig('one', 1), consoleSig('two', 2)],
      dropped: 0,
    });
    // Tab 2 is untouched by draining tab 1.
    expect(buf.peekGroups(2)).toHaveLength(1);
    // Draining again yields nothing; the drop counter reset.
    expect(buf.drain(1)).toEqual({ signals: [], dropped: 0 });
    expect(buf.droppedCount(1)).toBe(0);
  });

  it('dropped count accumulates past the cap, oldest signals first', () => {
    const buf = createPendingDiagnostics({ cap: 2 });
    buf.append(1, consoleSig('a', 1));
    buf.append(1, consoleSig('b', 2));
    expect(buf.droppedCount(1)).toBe(0);

    buf.append(1, consoleSig('c', 3)); // drops 'a'
    expect(buf.droppedCount(1)).toBe(1);
    buf.append(1, consoleSig('d', 4)); // drops 'b'
    expect(buf.droppedCount(1)).toBe(2);

    const drained = buf.drain(1);
    expect(drained.signals).toEqual([consoleSig('c', 3), consoleSig('d', 4)]);
    expect(drained.dropped).toBe(2);
    // drain reset the counter.
    expect(buf.droppedCount(1)).toBe(0);
    expect(buf.drain(1)).toEqual({ signals: [], dropped: 0 });
  });

  it('clear forgets a tab including its drop counter', () => {
    const buf = createPendingDiagnostics({ cap: 1 });
    buf.append(1, consoleSig('a', 1));
    buf.append(1, consoleSig('b', 2)); // drops 'a'
    expect(buf.droppedCount(1)).toBe(1);
    buf.clear(1);
    expect(buf.droppedCount(1)).toBe(0);
    expect(buf.peekGroups(1)).toEqual([]);
    expect(buf.drain(1)).toEqual({ signals: [], dropped: 0 });
  });

  it("onChange mirrors every state change with the tab's new snapshot", () => {
    const reports: Array<
      [number, PendingDiagnosticsSnapshot | null, 'append' | 'drain' | 'clear']
    > = [];
    const buf = createPendingDiagnostics({ onChange: (...args) => reports.push(args) });

    buf.append(1, consoleSig('one', 1));
    buf.append(1, consoleSig('two', 2));
    const lastAppend = reports.at(-1);
    expect(lastAppend?.[2]).toBe('append');
    expect(lastAppend?.[1]?.signals).toEqual([consoleSig('one', 1), consoleSig('two', 2)]);
    expect(lastAppend?.[1]?.dropped).toBe(0);

    // drain of a tracked tab deletes its buffer → reports null (delete the persisted key).
    buf.drain(1);
    const lastDrain = reports.at(-1);
    expect(lastDrain?.[2]).toBe('drain');
    expect(lastDrain?.[1]).toBeNull();
    // drain of an empty, never-tracked tab is a pure no-op: nothing reported.
    const before = reports.length;
    buf.drain(9);
    expect(reports.length).toBe(before);

    // drain of an empty-but-tracked tab with a pending drop count still reports (carry the drops),
    // but the mirror snapshot is null: the drop counter was already deleted before reporting.
    const dropper = createPendingDiagnostics({ cap: 1, onChange: (...a) => reports.push(a) });
    dropper.append(1, consoleSig('a', 1));
    dropper.append(1, consoleSig('b', 2)); // drops 'a'
    dropper.drain(1);
    const drainWithDrops = reports.at(-1);
    expect(drainWithDrops?.[2]).toBe('drain');
    expect(drainWithDrops?.[1]).toBeNull();

    // clear of a tab with live buffered signals reports null.
    buf.append(1, consoleSig('one', 1));
    buf.clear(1);
    const lastClear = reports.at(-1);
    expect(lastClear?.[2]).toBe('clear');
    expect(lastClear?.[1]).toBeNull();
    // clear of an untracked tab is a pure no-op: nothing reported.
    const beforeClear = reports.length;
    buf.clear(7);
    expect(reports.length).toBe(beforeClear);
  });

  it('seed restores a snapshot into an untouched tab, drops included', () => {
    const source = createPendingDiagnostics({ cap: 50 });
    source.append(7, consoleSig('one', 1));
    source.append(7, networkSig('https://a/x', 2));
    source.append(7, consoleSig('three', 3)); // cap 50, no drops yet

    const snap: PendingDiagnosticsSnapshot = {
      signals: [consoleSig('one', 1), networkSig('https://a/x', 2), consoleSig('three', 3)],
      dropped: 0,
    };

    const restored = createPendingDiagnostics({ cap: 50 });
    restored.seed(7, snap);
    expect(restored.droppedCount(7)).toBe(0);
    expect(restored.peekGroups(7)).toHaveLength(2); // console + network
    expect(restored.drain(7)).toEqual({ signals: snap.signals, dropped: 0 });

    // Drops ride the snapshot too.
    const dropper = createPendingDiagnostics({ cap: 1 });
    dropper.append(7, consoleSig('a', 1));
    dropper.append(7, consoleSig('b', 2)); // drops 'a', dropped = 1
    const snapWithDrops: PendingDiagnosticsSnapshot = {
      signals: [consoleSig('b', 2)],
      dropped: 1,
    };
    const restoredWithDrops = createPendingDiagnostics({ cap: 1 });
    restoredWithDrops.seed(7, snapWithDrops);
    expect(restoredWithDrops.droppedCount(7)).toBe(1);
    expect(restoredWithDrops.drain(7)).toEqual({ signals: [consoleSig('b', 2)], dropped: 1 });

    // seed only installs into an untouched slot: live signals already buffered win.
    const live = createPendingDiagnostics({ cap: 50 });
    live.append(7, consoleSig('live', 9));
    live.seed(7, snap);
    expect(live.drain(7).signals).toEqual([consoleSig('live', 9)]);
  });
});
