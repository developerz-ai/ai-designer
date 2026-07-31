// Grounding "this" — the picked element as turn context (#165 S6).
//
// THE GAP THIS CLOSES: the element picker resolved a selector, relayed it to the panel for DISPLAY
// only, and nothing ever carried it back to the service worker. The user clicked the picker, clicked
// the hero CTA (the chip reads `.hero__cta`), typed "make this 20% bigger", and the SW received the
// text alone — so the agent had to guess the referent and, on a page with several CTAs, restyled the
// wrong one while the chip kept claiming the element was attached. That falsifies
// docs/idea/live-edit.md ("Click → element becomes the chat's focus ('this'). Agent edits target
// it."), the product's signature interaction.
//
// The panel now echoes the still-attached selection on `UserMessage.selector` / `.selectors`
// (`src/shared/messages.ts`), and this module folds it into the instruction the model reads. Pure +
// chrome-free so the grounding text is unit-testable and identical every turn.

import type { StableSelector } from '@/shared/messages';

// Enough for the model to target the element and to judge how much to trust the selector; the
// picker's own fragility scoring is the reason `fragile` is worth carrying through.
function describe(selector: StableSelector): string {
  const fragile = selector.fragile ? ', fragile' : '';
  return `\`${selector.value}\` (${selector.strategy}${fragile})`;
}

/** De-duplicate by selector VALUE, `selector` first — the panel may send the single focus inside
 *  `selectors` as well, and the same element listed twice reads as two targets to the model. */
function unique(
  selector?: StableSelector,
  selectors?: readonly StableSelector[],
): StableSelector[] {
  const seen = new Set<string>();
  const out: StableSelector[] = [];
  for (const candidate of [...(selector ? [selector] : []), ...(selectors ?? [])]) {
    if (seen.has(candidate.value)) continue;
    seen.add(candidate.value);
    out.push(candidate);
  }
  return out;
}

/**
 * The grounding line for a picked selection, or `null` when nothing is attached. Phrased as a fact
 * about the user's words ("this"/"these" refers to …) rather than an instruction, so it informs the
 * model's resolution of the referent without competing with the user's actual request.
 */
export function focusContextLine(
  selector?: StableSelector,
  selectors?: readonly StableSelector[],
): string | null {
  const picked = unique(selector, selectors);
  if (picked.length === 0) return null;
  if (picked.length === 1) {
    return `[The user has an element selected on the page. "this"/"it" refers to ${describe(picked[0] as StableSelector)}.]`;
  }
  const list = picked.map((s) => describe(s)).join(', ');
  return `[The user has ${picked.length} elements selected on the page. "this"/"these"/"them" refers to: ${list}.]`;
}

/**
 * The user's instruction with its picked-element context prepended, or the text unchanged when
 * nothing is attached. This is what goes into the session thread — so a turn RESUMED after a
 * service-worker eviction still knows what "this" was, which a side-channel context wouldn't.
 */
export function groundUserText(
  text: string,
  selector?: StableSelector,
  selectors?: readonly StableSelector[],
): string {
  const line = focusContextLine(selector, selectors);
  return line ? `${line}\n${text}` : text;
}
