import { createEffect, onCleanup } from 'solid-js';

// Light dismiss for the panel's hand-rolled disclosures.
//
// `NavMenu` gets this free from the native `popover` attribute. The two menus that predate it —
// `ModelPicker` and `ShipBar`'s "Send to…" — are conditionally-rendered divs, and neither closed
// when you pressed somewhere else: the menu just stayed up over the composer until you pressed
// its trigger again or hit Escape. Converting those to `popover` means giving up their roving
// focus and search field, so they get the listener instead — once, here, rather than twice with
// one of them drifting.
//
// `pointerdown`, not `click`: a press that starts outside should dismiss even if the pointer is
// released elsewhere, and it fires before focus moves, so the menu is gone before whatever was
// pressed takes focus. Capture phase, so a handler inside the page that stops propagation cannot
// wedge the menu open.

/**
 * Close `isOpen` when a pointer press lands outside `root()`.
 *
 * Only listens while open — an always-armed document listener on a panel with three menus is
 * three listeners running on every press in the app.
 *
 * @param root the element that counts as "inside"; a press within it is ignored
 * @param isOpen whether the disclosure is currently showing
 * @param close called on an outside press
 */
export function dismissOnOutsidePress(
  root: () => HTMLElement | undefined,
  isOpen: () => boolean,
  close: () => void,
): void {
  createEffect(() => {
    if (!isOpen()) return;

    const onPointerDown = (event: PointerEvent): void => {
      const el = root();
      // `composedPath`, not `event.target`: the panel's own controls are plain DOM today, but a
      // press that originates in a shadow tree retargets to the host and `contains` would say
      // "outside" for something visually inside the menu.
      if (el && event.composedPath().includes(el)) return;
      close();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    onCleanup(() => document.removeEventListener('pointerdown', onPointerDown, true));
  });
}
