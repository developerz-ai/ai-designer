// "The work happens on the page the user is looking at" — enforced, not merely intended.
//
// THE HOLE THIS CLOSES: `background.ts` `contentDispatchFor` resolves every content-routed message
// with `message.tabId ?? defaultTabId`, and `Target.tabId` is on EVERY DomTool input — mutations
// included. Copy mode legitimately puts two tabs in play within one turn (the user's page, and a
// reference site opened in the background to copy FROM), so nothing about a second tab id looks
// wrong at the dispatch layer. The consequence: a model that passes the reference tab's id to
// `setStyle`/`batch`/`insertNode` restyles the site it was supposed to be LEARNING from, while the
// user watches their own page not change. Nothing anywhere enforced read-only on a reference tab.
//
// THE LINE IS PER-TAB, NEVER PER-FRAME. Editing inside an iframe of the active page is ordinary,
// legitimate work (payment widgets, embeds, cross-origin sections), so `frameId` is untouched here
// — every frame of the turn's tab stays writable.
//
// AND IT IS DRAWN AT *DESIGN MUTATIONS*, NOT AT EVERY SIDE EFFECT. Reads may target any tab; so may
// the page DRIVERS (`click`/`type`/`scrollTo`/…), because reaching content on a reference site is
// exactly how copy mode reads it — the system prompt tells the model to do that. Drivers change no
// design and are never recorded as edits. What is refused is the set that mutates the page's
// appearance and lands in the changeset: those must only ever hit the tab the turn owns, because a
// changeset is shipped as a diff against the user's page and an edit recorded against some other
// origin is not merely useless, it is wrong.
//
// Pure + chrome-free + no `any`, so the policy is unit-testable in isolation and the SW keeps one
// source of truth for it (same reasoning as `capture-policy.ts`, which this deliberately mirrors).

/** Message types that CHANGE THE DESIGN of a page and are recorded into the changeset. Kept as a
 *  literal set rather than derived from the `DomTool` union: the union also holds the reads, and a
 *  new tool must be classified deliberately — a mutation that silently defaults to "allowed
 *  anywhere" is exactly the failure this module exists to prevent. Mirrors the mutating half of
 *  `src/shared/messages.ts`'s `DomTool`. */
export const DESIGN_MUTATIONS: ReadonlySet<string> = new Set([
  'setStyle',
  'setText',
  'setAttr',
  'addClass',
  'removeClass',
  'batch',
  'insertNode',
  'moveNode',
  'removeNode',
  'undo',
  'discardUndo',
]);

/** Whether one content-routed message type mutates the design (and so is pinned to the turn's
 *  tab). Everything else — every read, every driver, every capture — may address any tab. */
export function isDesignMutation(type: string): boolean {
  return DESIGN_MUTATIONS.has(type);
}

/**
 * Why this message may not run, or `null` when it may. A design mutation aimed at a tab other than
 * the one the turn resolved at start is refused; everything else passes.
 *
 * The refusal is phrased as an INSTRUCTION the model can act on, in the same register as
 * `capture-target.ts`'s screenshot refusal (which likewise refuses rather than silently
 * auto-retargeting): it names the two tabs, says which one is the subject, and tells the model what
 * to do instead. A bare "not allowed" would send it retrying the same call with the same id.
 */
export function mutationBlockedReason(
  type: string,
  messageTabId: number | undefined,
  turnTabId: number,
): string | null {
  if (messageTabId === undefined || messageTabId === turnTabId) return null;
  if (!isDesignMutation(type)) return null;
  return (
    `\`${type}\` was aimed at tab ${messageTabId}, but this turn is designing tab ${turnTabId} — ` +
    'the page the user is looking at. Edits only ever apply to that tab, because the changeset ' +
    'they produce is shipped as a diff against it. Another tab is read-only: you may inspect it, ' +
    'screenshot it and drive it to reach content, but not restyle it. Re-send this without ' +
    '`tabId` (which defaults to the tab being designed), or apply the change there instead.'
  );
}
