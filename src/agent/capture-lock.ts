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
 *  (the stored link swallows the rejection, the caller still sees it); chains settle resolved, so
 *  the map stays tiny. */
export function createCaptureLock(): CaptureLock {
  const locks = new Map<number, Promise<unknown>>();
  return <T>(tabId: number, run: () => Promise<T>): Promise<T> => {
    const prior = locks.get(tabId) ?? Promise.resolve();
    const result = prior.then(run, run);
    locks.set(
      tabId,
      result.catch(() => {}),
    );
    return result;
  };
}

/** The SW-wide instance — one chain per tab, shared by every capture dispatch in background.ts. */
export const withCaptureLock = createCaptureLock();
