// The supersede-ordering chain (#168 B). A new send AWAITS the finalization of every earlier turn
// that has not settled yet before appending its own user message, so the thread stays
// [user1, assistant1(partial), user2, …]. A single "latest turn" slot was not enough: when B
// superseded A and C superseded B while B was still in setup (or B failed setup early), the slot
// held only B — C never waited for A, and A's partial reply landed after C's prompt.
//
// So each entry's `done` is its own settlement AND its predecessor's, and `pending()` names every
// turn in the lineage still unsettled — the set a caller FORFEITS when its bounded wait times out
// (a forfeited turn's late finalization skips its append). A settled predecessor is dropped from
// the chain, so the lineage never grows past the turns actually in flight.
//
// Pure + chrome-free; unit-testable.

export interface SettlingTurn {
  /** The newest turn in the lineage. */
  readonly id: string;
  /** Resolves once this turn AND every predecessor it chained onto have settled. Never rejects. */
  readonly done: Promise<void>;
  /** Ids of the lineage's turns not settled yet, oldest first. */
  pending(): string[];
}

/** Chain turn `id` (settling with `own`) onto `prior`. `own` may reject; the chain never does. */
export function chainSettlingTurn(
  prior: SettlingTurn | null,
  id: string,
  own: Promise<unknown>,
): SettlingTurn {
  let settled = false;
  let prev = prior;
  const ownDone = own.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  if (prior) {
    void prior.done.then(() => {
      prev = null;
    });
  }
  return {
    id,
    done: prior ? Promise.all([prior.done, ownDone]).then(() => undefined) : ownDone,
    pending: () => [...(prev?.pending() ?? []), ...(settled ? [] : [id])],
  };
}
