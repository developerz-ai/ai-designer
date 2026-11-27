// Per-key serialization for read-modify-write on `chrome.storage.local` maps. Each writer in
// store.ts / tool-grants.ts reads the WHOLE map, changes one entry, and writes the whole map back;
// two of them interleaving across the awaits both read the same old map and the second write
// drops the first one's update (two quick grant toggles, a server save racing its OAuth config).
// Running every writer of one storage key through ONE promise chain makes each read see the
// previous write.
//
// Scope: one JS context. These writers are SW-only, so the SW's chain covers every write to the
// key. Not re-entrant — a locked section must never call another writer of the SAME key (it would
// wait on itself).

const chains = new Map<string, Promise<void>>();

/** Run `work` after every earlier `withKeyLock(key, …)` call has settled, and before any later
 *  one starts. A rejected `work` rejects its own caller but never poisons the chain. */
export function withKeyLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  const result = prior.then(work);
  const link = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, link);
  // Self-evict once settled, unless a newer call has already queued behind this one.
  void link.then(() => {
    if (chains.get(key) === link) chains.delete(key);
  });
  return result;
}
