import { createSignal } from 'solid-js';
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

export { error, multiSelectors, pickerActive, rect, selector, xpath };

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
