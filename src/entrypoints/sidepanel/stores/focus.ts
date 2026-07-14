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
  rect: Rect | null;
  pickerActive: boolean;
}

/** Pure reducer: derives the next focus state from an SW->panel message. */
export function reduceFocus(state: FocusState, msg: SwToPanel): FocusState {
  switch (msg.type) {
    case 'focus':
      return { ...state, selector: msg.selector, rect: msg.rect };
    case 'picker-state':
      if (!msg.active) {
        return { pickerActive: false, selector: null, rect: null };
      }
      return { ...state, pickerActive: true };
    default:
      return state;
  }
}

const [selector, setSelector] = createSignal<StableSelector | null>(null);
const [rect, setRect] = createSignal<Rect | null>(null);
const [pickerActive, setPickerActive] = createSignal<boolean>(false);

export { pickerActive, rect, selector };

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
      { selector: selector(), rect: rect(), pickerActive: pickerActive() },
      msg,
    );
    setSelector(next.selector);
    setRect(next.rect);
    setPickerActive(next.pickerActive);
  });
}

/** Manual reset of the focus state. */
export function clearFocus(): void {
  setSelector(null);
  setRect(null);
  setPickerActive(false);
}

/** Composer's "attach" affordance: ask the content script (via the SW) to start the
 *  Cursor-style element picker on the active tab. The resulting `focus`/`picker-state`
 *  pushes fold in through `initFocusStore` above — this only fires the request. */
export async function startPicker(): Promise<void> {
  await request({ type: 'start-picker' }, OkResult);
}

/** Cancel an in-flight pick (ContextChip's dismiss while `pickerActive`). Clears local
 *  state immediately rather than waiting on the `picker-state` push, so the chip closes
 *  without a round-trip flicker. */
export async function stopPicker(): Promise<void> {
  clearFocus();
  await request({ type: 'stop-picker' }, OkResult);
}
