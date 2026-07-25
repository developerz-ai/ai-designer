// Per-tab capture mutex (slice 13 / #59). Same-step tool calls execute concurrently (the AI SDK
// Promise.all's them), and the two capture paths both move or read the page's scroll: an element
// screenshot dequeued during a full-page stitch's per-band settle would scroll the page under that
// band's capture (one corrupted band baked into the stitched PNG), and a stitch starting
// mid-element-scroll would read a mid-scroll scrollY from page-metrics and "restore" the page to
// somewhere it never was. Serializing the capture pair per tab closes that; the content-side tool
// queue (src/entrypoints/content.ts) serializes individual tool messages but cannot make a
// multi-message sequence (the stitch) atomic against them.

export type CaptureLock = <T>(tabId: number, run: () => Promise<T>) => Promise<T>;

/** A fresh per-tab promise-chain mutex. FIFO per tab; a rejected run does not poison the chain
 *  (the stored link swallows the rejection, the caller still sees it). The stored link also DROPS
 *  the run's value — a fulfilled link would otherwise retain the last capture's ToolResult (a
 *  possibly multi-MB stitched dataUrl) for the lock's whole lifetime. Settled links are evicted
 *  (compare-and-delete, below) so one dead promise per touched tabId is not pinned for the SW's
 *  lifetime either (#137). The map is injectable purely so the unit test can observe eviction. */
export function createCaptureLock(locks: Map<number, Promise<unknown>> = new Map()): CaptureLock {
  return <T>(tabId: number, run: () => Promise<T>): Promise<T> => {
    const prior = locks.get(tabId) ?? Promise.resolve();
    const result = prior.then(run, run);
    const link = result.then(
      () => {},
      () => {},
    );
    locks.set(tabId, link);
    // Compare-and-delete eviction: once this link settles it is the chain's tail ONLY if no newer
    // acquirer has superseded it — a queued acquirer installs its own link before this eviction
    // microtask runs (its `then` on the settled prior queues ahead), so an unconditional delete
    // would evict that live replacement and the next acquirer would fork a fresh chain and run
    // CONCURRENTLY with the queued one. The link never rejects (its handlers swallow the run's
    // rejection), so this fires exactly on settle.
    void link.then(() => {
      if (locks.get(tabId) === link) locks.delete(tabId);
    });
    return result;
  };
}

/** The SW-wide instance — one chain per tab, shared by every capture dispatch in background.ts. */
export const withCaptureLock = createCaptureLock();
