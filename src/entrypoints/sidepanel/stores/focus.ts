import { createSignal } from 'solid-js';
import { i18n } from '#i18n';
import { OkResult, type Rect, type StableSelector, type SwToPanel } from '@/shared/messages';
import { request } from './bus';
import { connectPort, subscribeToSw } from './sw-stream';

// Focus store: tracks the picker's target element + activation state for the
// panel UI. reduceFocus is a pure function (no chrome, no signals) so the
// transition logic is unit-testable with zero mocks; initFocusStore wires it
// to the live service-worker stream.

export interface FocusState {
  selector: StableSelector | null;
  /** The pinned element's absolute XPath, echoed back on the next `user-message` so the grounding
   *  line can name an exact node even when the leading CSS selector is fragile. Null when the pick
   *  came from a content script that predates it. */
  xpath: string | null;
  rect: Rect | null;
  pickerActive: boolean;
  /** The shift-multi-select set (`focus-multi`) — several referents at once, chipped alongside the
   *  single pin and echoed back as `UserMessage.selectors`. */
  selectors: StableSelector[];
}

/** Pure reducer: derives the next focus state from an SW->panel message. */
export function reduceFocus(state: FocusState, msg: SwToPanel): FocusState {
  switch (msg.type) {
    case 'focus':
      return { ...state, selector: msg.selector, xpath: msg.xpath ?? null, rect: msg.rect };
    case 'focus-multi':
      // An EMPTY array is meaningful: the user cleared the multi-selection, so the chips go with
      // it (src/shared/messages.ts `focus-multi`).
      return { ...state, selectors: msg.selectors };
    case 'picker-state':
      // Only the picker's activation state. `src/dom/picker.ts` does NOT stop after a pick, so the
      // natural "done picking" gesture — Escape, i.e. `picker.stop()` — arrives here as
      // `{active:false}`; clearing the selection on it threw away the pin the user had just made.
      // The selection is dropped on an explicit `clearFocus()` (the chip's dismiss) instead.
      return { ...state, pickerActive: msg.active };
    default:
      return state;
  }
}

const [selector, setSelector] = createSignal<StableSelector | null>(null);
const [xpath, setXpath] = createSignal<string | null>(null);
const [rect, setRect] = createSignal<Rect | null>(null);
const [pickerActive, setPickerActive] = createSignal<boolean>(false);
const [multiSelectors, setMultiSelectors] = createSignal<StableSelector[]>([]);
// Picker RPC failures (a worker mid-restart answers "Receiving end does not exist"): every other
// store action surfaces its failure rather than rejecting into an unhandled rejection, which the
// UI cannot show and Sentry records as a crash.
const [error, setError] = createSignal<string | null>(null);

// Every element pinned this session, newest first, deduped by selector and capped (#175). It is
// what the composer's `@` menu offers: without a history the menu could only list what is ALREADY
// attached, which is exactly the set the user has no reason to attach again. Detaching a chip
// deliberately does NOT evict from here — "I removed that by mistake" is the single most likely
// reason to reach for the menu.
const RECENT_MAX = 8;
const [recentReferences, setRecentReferences] = createSignal<StableSelector[]>([]);

export { error, multiSelectors, pickerActive, recentReferences, rect, selector, xpath };

/** Fold newly-seen pins into the recents, newest first. Pure over its inputs so the dedupe and
 *  cap are unit-testable without a store. */
export function foldRecent(current: StableSelector[], seen: StableSelector[]): StableSelector[] {
  const next = [...current];
  for (const sel of seen) {
    const at = next.findIndex((r) => r.value === sel.value);
    if (at !== -1) next.splice(at, 1);
    next.unshift(sel);
  }
  return next.slice(0, RECENT_MAX);
}

let wired = false;

/** Open the SW port and fold incoming messages into the focus signals.
 * Idempotent: guards against a double-subscribe if called more than once. */
export function initFocusStore(): void {
  if (wired) {
    return;
  }
  wired = true;
  connectPort();
  subscribeToSw((msg) => {
    const next = reduceFocus(
      {
        selector: selector(),
        xpath: xpath(),
        rect: rect(),
        pickerActive: pickerActive(),
        selectors: multiSelectors(),
      },
      msg,
    );
    setSelector(next.selector);
    setXpath(next.xpath);
    setRect(next.rect);
    setPickerActive(next.pickerActive);
    setMultiSelectors(next.selectors);
    // Recents are fed from the SAME echo that feeds the chips, so a mention and a pick are
    // indistinguishable downstream — there is no second write path into the reference set.
    setRecentReferences((current) =>
      foldRecent(current, orderedReferences(next.selector, next.selectors)),
    );
  });
}

/** Manual reset of the focus state — the one place a pin is dropped (the chip's dismiss). */
export function clearFocus(): void {
  setSelector(null);
  setXpath(null);
  setRect(null);
  setPickerActive(false);
  setMultiSelectors([]);
}

/** The conversation's attached elements as ONE ordered list: the single pin first, then the
 *  shift-multi set. The panel shows these as numbered chips and echoes them back on the next
 *  send, so the numbering a user sees in a chip is the numbering the agent is grounded on.
 *  Pure over its inputs — exported so the ordering contract is unit-testable. */
export function orderedReferences(
  pin: StableSelector | null,
  multi: StableSelector[],
): StableSelector[] {
  return pin ? [pin, ...multi] : multi;
}

/** Detach ONE reference by its position in `orderedReferences`. Index 0 with a pin present drops
 *  the pin; anything else splices the multi set.
 *
 *  The multi half is ROUND-TRIPPED to the content script, not merely forgotten here. The picker
 *  owns the committed selection and `multi-select-changed` is the only write path into
 *  `multiSelectors`, so a panel-local removal was reverted by the picker's very next echo: the
 *  user dismissed a chip, shift-clicked one more element, and the dismissed one silently
 *  reappeared — and went to the model as grounding. The local splice stays as an optimistic
 *  update so the chip disappears without a round-trip; the echo then confirms it.
 *
 *  The pin has no content-side state (it is not in the picker's `selected` set), so index 0 is
 *  panel-local by nature — but it still travels, because the picker draws the pin as box 1 and
 *  that outline has to go with the chip. */
export function removeReference(index: number): void {
  const hasPin = selector() !== null;
  const target = orderedReferences(selector(), multiSelectors())[index];
  if (hasPin && index === 0) {
    setSelector(null);
    setXpath(null);
    setRect(null);
  } else {
    const multiIndex = hasPin ? index - 1 : index;
    setMultiSelectors((current) => current.filter((_, i) => i !== multiIndex));
  }
  if (target) void deselectOnPage(target.value);
}

/** Tell the content script to drop this element from the picker's committed selection. Failure is
 *  surfaced like every other store action rather than rejecting into an unhandled rejection — the
 *  chip is already gone locally, so a dead content script degrades to the old panel-local
 *  behaviour instead of blocking the dismiss. */
async function deselectOnPage(value: string): Promise<void> {
  try {
    // `request` resolves on ANY response matching `OkResult` — including `{ ok: false }`, which
    // is what a tab with no content script answers. Ignoring it meant the chip vanished locally
    // while the page kept its rectangle and the picker kept the element committed, ready to echo
    // it back on the next pick.
    const result = await request({ type: 'deselect-element', value }, OkResult);
    if (!result.ok) setError(i18n.t('focus.error.pageUnreachable'));
  } catch (e) {
    setError(errMsg(e));
  }
}

/** Attach a remembered element without a pick gesture — the composer's `@` menu (#175). Goes to
 *  the content world and comes back through `multi-select-changed`, exactly like `removeReference`
 *  does in the other direction, so there is only ever ONE write path into the reference set and a
 *  mention is indistinguishable from a shift-click downstream. Optimistically local? No: the
 *  picker draws the numbered box, and a chip without its rectangle is the desync this design
 *  exists to prevent. */
export async function mentionReference(value: string): Promise<void> {
  setError(null);
  try {
    // Same trap as `deselectOnPage`: `{ ok: false }` satisfies `OkResult`. Here it matters more
    // — the composer has already deleted the `@query` run, so a silently-dropped attach leaves
    // the user with neither the text they typed nor the reference they asked for.
    const result = await request({ type: 'select-element', value }, OkResult);
    if (!result.ok) setError(i18n.t('focus.error.pageUnreachable'));
  } catch (e) {
    setError(errMsg(e));
  }
}

/** Composer's "attach" affordance: ask the content script (via the SW) to start the
 *  Cursor-style element picker on the active tab. The resulting `focus`/`picker-state`
 *  pushes fold in through `initFocusStore` above — this only fires the request.
 *  Never throws: a failed RPC surfaces via `error()` like every other store action. */
export async function startPicker(): Promise<void> {
  setError(null);
  try {
    await request({ type: 'start-picker' }, OkResult);
  } catch (e) {
    setError(errMsg(e));
  }
}

/** Cancel an in-flight pick (ContextChip's dismiss while `pickerActive`). Clears local
 *  state immediately rather than waiting on the `picker-state` push, so the chip closes
 *  without a round-trip flicker. */
export async function stopPicker(): Promise<void> {
  clearFocus();
  setError(null);
  try {
    await request({ type: 'stop-picker' }, OkResult);
  } catch (e) {
    setError(errMsg(e));
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
