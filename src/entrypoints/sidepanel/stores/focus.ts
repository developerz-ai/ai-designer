import { createSignal } from 'solid-js';
import type { Rect, StableSelector, SwToPanel } from '@/shared/messages';
import { connectPort, subscribeToSw } from './bus';

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

/** Open the SW port and fold incoming messages into the focus signals. */
export function initFocusStore(): void {
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
