import { describe, expect, it } from 'vitest';
import { createPicker } from '@/dom/picker';
import { type FocusState, reduceFocus } from '@/entrypoints/sidepanel/stores/focus';
import type { ContentToSw } from '@/shared/messages';
import { relayToPanel } from '@/shared/relay';

// Integration: the picker's pick -> the panel's focus stream, end to end minus the chrome bus.
// Each hop is independently unit-tested (test/unit/picker.test.ts, relay.test.ts, focus.test.ts);
// this proves they compose the way content.ts + background.ts actually wire them: a real jsdom
// click on the picker emits a ContentToSw event, relayToPanel projects it to an SwToPanel
// message, and reduceFocus folds it into the panel's FocusState the UI reads.

const INITIAL: FocusState = { selector: null, rect: null, pickerActive: false };

function pickerToFocus(): { picker: ReturnType<typeof createPicker>; state: () => FocusState } {
  let state = INITIAL;
  const emit = (msg: ContentToSw): void => {
    const panelMsg = relayToPanel(msg);
    if (panelMsg) state = reduceFocus(state, panelMsg);
  };
  return { picker: createPicker(emit, document), state: () => state };
}

function byId(id: string): Element {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fixture missing: #${id}`);
  return el;
}

function click(el: Element, opts: MouseEventInit = {}): void {
  el.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...opts }),
  );
}

describe('picker -> relay -> focus store', () => {
  it('starting the picker flips pickerActive in the panel store', () => {
    const { picker, state } = pickerToFocus();
    picker.start();
    expect(state()).toEqual({ selector: null, rect: null, pickerActive: true });
    picker.destroy();
  });

  it('a plain click focuses the resolved stable selector + rect in the panel store', () => {
    document.body.innerHTML = '<button id="b" data-testid="cta">Buy</button>';
    const { picker, state } = pickerToFocus();
    picker.start();

    click(byId('b'));

    expect(state().selector).toMatchObject({ value: '[data-testid="cta"]', strategy: 'data-attr' });
    expect(state().rect).toMatchObject({ x: 0, y: 0, width: 0, height: 0 });
    picker.destroy();
  });

  it('stopping the picker clears the focused selection', () => {
    document.body.innerHTML = '<button id="b" data-testid="cta">Buy</button>';
    const { picker, state } = pickerToFocus();
    picker.start();
    click(byId('b'));
    expect(state().selector).not.toBeNull();

    picker.stop();
    expect(state()).toEqual({ selector: null, rect: null, pickerActive: false });
    picker.destroy();
  });

  it('a shift-click multi-selection does not affect the single-focus selector', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const { picker, state } = pickerToFocus();
    picker.start();

    click(byId('a'), { shiftKey: true });

    // multi-select-changed relays to `multi-select`, which reduceFocus has no case for (its
    // default branch returns state unchanged) — the two selection modes stay independent.
    expect(state().selector).toBeNull();
    expect(state().pickerActive).toBe(true);
    picker.destroy();
  });
});
