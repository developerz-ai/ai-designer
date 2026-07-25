import { describe, expect, it } from 'vitest';
import { createCaptureLock } from '@/agent/capture-lock';

describe('createCaptureLock', () => {
  it('serializes contended runs per tab (FIFO)', async () => {
    const lock = createCaptureLock();
    const order: string[] = [];
    const slow = lock(1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow');
      return 'a';
    });
    const fast = lock(1, async () => {
      order.push('fast');
      return 'b';
    });
    expect(await Promise.all([slow, fast])).toEqual(['a', 'b']);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('stays alive after a rejected run — the caller sees the rejection, the chain continues', async () => {
    const lock = createCaptureLock();
    await expect(lock(1, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(lock(1, () => Promise.resolve('after'))).resolves.toBe('after');
  });

  it('does not serialize across tabs', async () => {
    const lock = createCaptureLock();
    const order: string[] = [];
    const a = lock(1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('a');
    });
    const b = lock(2, async () => {
      order.push('b');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['b', 'a']);
  });
});

// #137 item 1 — settled-link eviction. The map is injected so the test can observe it directly;
// a settled link is behaviorally transparent (a fresh chain on Promise.resolve() runs just as
// immediately), so retention is only visible as map size.
describe('createCaptureLock eviction (#137)', () => {
  it('evicts a settled lock — memory stays flat across many tabIds', async () => {
    const locks = new Map<number, Promise<unknown>>();
    const lock = createCaptureLock(locks);
    for (let tab = 1; tab <= 50; tab++) {
      await lock(tab, () => Promise.resolve(tab));
    }
    await new Promise((resolve) => setTimeout(resolve, 0)); // flush the last eviction microtask
    expect(locks.size).toBe(0);
  });

  it('eviction does not break the chain — a contended second acquirer still queues (FIFO)', async () => {
    const locks = new Map<number, Promise<unknown>>();
    const lock = createCaptureLock(locks);
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = lock(1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('a');
    });
    const b = lock(1, async () => {
      order.push('b-start');
      await gate;
      order.push('b-end');
    });
    const c = lock(1, async () => {
      order.push('c');
    });
    release();
    await Promise.all([a, b, c]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['a', 'b-start', 'b-end', 'c']);
    expect(locks.size).toBe(0); // the chain's tail evicted itself once settled
  });

  it('a superseded link never evicts its replacement (the compare half)', async () => {
    const locks = new Map<number, Promise<unknown>>();
    const lock = createCaptureLock(locks);
    const order: string[] = [];
    let releaseB: () => void = () => {};
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    // A settles; its eviction is queued as a microtask on A's link. This await's continuation was
    // attached to A's RESULT before the eviction was attached to A's LINK, so it runs first — B
    // below acquires inside the window where A's settled link is still the map entry, then
    // supersedes it (reaction order is spec FIFO, so the window is deterministic).
    await lock(1, async () => {
      order.push('a');
    });
    const b = lock(1, async () => {
      order.push('b-start');
      await bGate;
      order.push('b-end');
    });
    // A's eviction has now fired with B's link in the map — the compare must skip the delete.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(locks.size).toBe(1); // B's live link survived A's eviction
    const c = lock(1, async () => {
      order.push('c');
    });
    releaseB();
    await Promise.all([b, c]);
    // An unconditional delete would have evicted B's entry, so C would have forked a fresh chain
    // and run CONCURRENTLY with B ('c' before 'b-end'); with the compare it queued behind.
    expect(order).toEqual(['a', 'b-start', 'b-end', 'c']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(locks.size).toBe(0);
  });

  it('a rejected run still evicts its link once settled — and the next acquirer starts fresh', async () => {
    const locks = new Map<number, Promise<unknown>>();
    const lock = createCaptureLock(locks);
    await expect(lock(7, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(locks.size).toBe(0);
    await expect(lock(7, () => Promise.resolve('ok'))).resolves.toBe('ok');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(locks.size).toBe(0);
  });
});
