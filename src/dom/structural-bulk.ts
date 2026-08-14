import type { Reversible } from '@/dom/mutate';
import { queryAll } from '@/dom/read';

// Bulk structural editing — one call, many targets, resolved BEFORE any of them is touched.
//
// `BatchInput` (src/shared/messages.ts) deliberately excludes structural ops, and it is right to:
// batching arbitrary insert/move/remove calls is a footgun, because each op moves the anchors the
// later ops in the same array were written against. But that reasoning does not extend to "remove
// these 12 spacer rows", which is a real overhaul action currently costing 12 model steps and 12
// bus round-trips. The difference is that a bulk op applies ONE operation to a SET, so there are no
// later ops written against anything.
//
// The safety property is resolve-then-mutate, and it is enforced by the signature: this module's
// applier takes an already-resolved `Element[]` and there is no overload that accepts a selector.
// Resolution happens once, up front, in `resolveTargets`.
//
// The second hazard is the one resolution alone does not fix: targets that CONTAIN other targets.
// Removing a parent detaches its children, so by the time a nested target's turn comes it is no
// longer in the document — and mutating a detached node "succeeds" into an invisible tree. Every
// target is re-checked for connectedness at its own turn and reported as skipped, never as applied.
//
// Pure DOM, no chrome.*, no schema — jsdom-testable, and the bus shape is the caller's problem.

/** Cap on how many elements one bulk call may touch. Past this the failure report stops being
 *  reviewable and a single wrong selector becomes an un-auditable page rewrite. */
export const MAX_BULK_TARGETS = 50;

/** Per-target outcome, positionally indexed so a failure names WHICH target failed — the same
 *  contract `BatchResult` holds, for the same reason (a bare count leaves the model guessing). */
export interface BulkTargetResult {
  readonly index: number;
  /** The target's own stable selector, so a failure is addressable without re-querying. */
  readonly selector: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface BulkOutcome<M extends Reversible> {
  readonly applied: number;
  readonly failed: number;
  readonly results: readonly BulkTargetResult[];
  /**
   * The mutations that actually applied, in application order. The CALLER records each one
   * separately: undo/redo granularity stays per-element exactly as it is for a single op, because
   * a bulk call is a transport and resolution optimization, never a transaction. A user who undoes
   * once should get one row back, not twelve.
   */
  readonly mutations: ReadonlyArray<{
    readonly index: number;
    readonly element: Element;
    readonly mutation: M;
  }>;
}

export interface ResolveOutcome {
  readonly targets: readonly Element[];
  /** Present when the selector matched more than {@link MAX_BULK_TARGETS} — says so in words
   *  rather than silently editing the first fifty. */
  readonly note?: string;
}

/**
 * Resolve every target ONCE, into a static array, before a single mutation runs.
 *
 * `queryAll` already returns a snapshot, but the point is architectural rather than incidental: no
 * consumer of this module can re-query between operations, because none of them ever holds the
 * selector. Over the cap the call resolves nothing and explains why — half-applying a bulk edit the
 * user cannot see the extent of is worse than refusing it.
 */
export function resolveTargets(root: ParentNode, selector: string): ResolveOutcome {
  const all = queryAll(root, selector);
  if (all.length > MAX_BULK_TARGETS) {
    return {
      targets: [],
      note: `\`${selector}\` matches ${all.length} elements; a bulk structural edit is capped at ${MAX_BULK_TARGETS}. Narrow the selector, or apply this in named groups.`,
    };
  }
  return { targets: all };
}

/**
 * Apply one operation to every resolved target, in document order.
 *
 * Order is document order for every op. For removals it is irrelevant (node references are held);
 * for wraps and replacements it is the order a reader would expect, which is what makes the result
 * predictable enough to review.
 *
 * `guard` is the caller's policy check (the executor's own-chrome / `<html>`/`<body>` refusals). A
 * refused or failed target does not stop the rest: the common failure is one target out of twelve,
 * and aborting there would throw away eleven good mutations the model would have to re-derive.
 */
export function applyStructuralBulk<M extends Reversible>(
  targets: readonly Element[],
  apply: (el: Element) => M,
  opts: {
    /** Names a target for the result. The caller injects it (the selector engine), so this module
     *  stays free of that dependency and testable with a stub. */
    readonly describe: (el: Element) => string;
    readonly guard?: (el: Element) => string | null;
  },
): BulkOutcome<M> {
  const results: BulkTargetResult[] = [];
  const mutations: Array<{ index: number; element: Element; mutation: M }> = [];

  targets.forEach((el, index) => {
    const selector = opts.describe(el);
    const record = (error?: string): void => {
      results.push({ index, selector, ok: error === undefined, ...(error ? { error } : {}) });
    };

    // Re-checked at this target's OWN turn, not at resolution time: an earlier target in this same
    // call may have been its ancestor, in which case it is already gone from the page. Mutating it
    // would "succeed" into a detached tree and be reported as an edit the user can never see.
    if (!el.isConnected) {
      record(
        'Skipped: this element left the document earlier in the same call (an earlier target contained it).',
      );
      return;
    }
    const refused = opts.guard?.(el);
    if (refused) {
      record(refused);
      return;
    }
    try {
      const mutation = apply(el);
      mutations.push({ index, element: el, mutation });
      record();
    } catch (err) {
      record(err instanceof Error ? err.message : String(err));
    }
  });

  const failed = results.filter((r) => !r.ok).length;
  return { applied: results.length - failed, failed, results, mutations };
}

/** The failure text a bulk call reports. Leads with WHICH targets failed, because the model's next
 *  move is to fix the named ones — a count alone would have to be cross-referenced. */
export function bulkError(outcome: BulkOutcome<Reversible>): string {
  const bad = outcome.results
    .filter((r) => !r.ok)
    .map((r) => `#${r.index} (${r.selector})`)
    .join(', ');
  return `${outcome.applied} of ${outcome.results.length} applied; failed: ${bad}. The applied ops are already live and must not be re-sent.`;
}
