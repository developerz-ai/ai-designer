import { render } from '@solidjs/testing-library';
import { createSignal, onCleanup } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { dismissOnOutsidePress } from '@/entrypoints/sidepanel/components/dismiss';

// Light dismiss for the two hand-rolled disclosures (ModelPicker, ShipBar's "Send to…").
// Neither closed on an outside press before this — the menu sat over the composer until its own
// trigger was pressed again.

function mount(open: () => boolean, close: () => void) {
  let root: HTMLDivElement | undefined;
  const outside = document.createElement('button');
  document.body.append(outside);

  const rendered = render(() => {
    onCleanup(() => outside.remove());
    dismissOnOutsidePress(() => root, open, close);
    return (
      <div ref={root}>
        <button type="button">inside</button>
      </div>
    );
  });

  return { rendered, outside, inside: () => root?.querySelector('button') as HTMLElement };
}

function press(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
}

describe('dismissOnOutsidePress', () => {
  it('closes on a press outside the root', () => {
    const close = vi.fn();
    const { outside } = mount(() => true, close);

    press(outside);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('ignores a press inside the root', () => {
    const close = vi.fn();
    const { inside } = mount(() => true, close);

    press(inside());
    expect(close).not.toHaveBeenCalled();
  });

  it('does not listen at all while closed', () => {
    // An always-armed document listener per menu runs on every press in the panel; three menus
    // would be three handlers deep in the hot path of every click.
    const close = vi.fn();
    const { outside } = mount(() => false, close);

    press(outside);
    expect(close).not.toHaveBeenCalled();
  });

  it('detaches its listener when the disclosure closes', () => {
    const close = vi.fn();
    const [open, setOpen] = createSignal(true);
    const { outside } = mount(open, close);

    press(outside);
    expect(close).toHaveBeenCalledTimes(1);

    setOpen(false);
    press(outside);
    expect(close).toHaveBeenCalledTimes(1); // still 1 — the listener is gone
  });

  it('detaches on unmount, so a closed panel leaves nothing on document', () => {
    const close = vi.fn();
    const { rendered, outside } = mount(() => true, close);

    rendered.unmount();
    press(outside);
    expect(close).not.toHaveBeenCalled();
  });
});
