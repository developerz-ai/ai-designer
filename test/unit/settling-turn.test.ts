import { describe, expect, it } from 'vitest';
import { chainSettlingTurn } from '@/agent/settling-turn';

// settling-turn unit: the supersede-ordering chain. With a single "latest turn" slot, C (which
// superseded B, which superseded A while B was still in setup) never waited for A — A's partial
// reply could land after C's prompt.

function deferred() {
  let resolve: () => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('chainSettlingTurn', () => {
  it('a newer entry is not done until every unsettled predecessor is', async () => {
    const a = deferred();
    const b = deferred();
    const c = deferred();
    const A = chainSettlingTurn(null, 'A', a.promise);
    const B = chainSettlingTurn(A, 'B', b.promise);
    const C = chainSettlingTurn(B, 'C', c.promise);
    let cDone = false;
    void C.done.then(() => {
      cDone = true;
    });
    b.resolve(); // B failed setup early / settled
    c.resolve();
    await flush();
    expect(cDone).toBe(false); // A still in flight
    expect(C.pending()).toEqual(['A']);
    a.resolve();
    await flush();
    expect(cDone).toBe(true);
    expect(C.pending()).toEqual([]);
  });

  it('pending() lists the whole unsettled lineage, oldest first — the set to forfeit', () => {
    const A = chainSettlingTurn(null, 'A', deferred().promise);
    const B = chainSettlingTurn(A, 'B', deferred().promise);
    expect(chainSettlingTurn(B, 'C', deferred().promise).pending()).toEqual(['A', 'B', 'C']);
  });

  it('never rejects, even when a turn’s own promise does', async () => {
    const a = deferred();
    const A = chainSettlingTurn(null, 'A', a.promise);
    a.reject(new Error('boom'));
    await expect(A.done).resolves.toBeUndefined();
    expect(A.pending()).toEqual([]);
  });
});
