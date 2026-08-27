import { createComputed, createSignal, onCleanup } from 'solid-js';

// Exit animations for things that unmount.
//
// Every overlay in this panel is a `<Show when={open()}>`, so closing removes the node from the
// DOM on the same tick — there is no frame in which an exit transition could run, which is why
// menus and dialogs opened with a fade and vanished with a hard cut. CSS alone cannot fix that
// for a conditionally-rendered node: `@starting-style` + `allow-discrete` handles the enter and
// the `display` flip, but only for an element that stays in the tree.
//
// So: keep it mounted a little longer than the state says, and expose WHICH phase it is in so
// the stylesheet can pick an animation. One primitive, used by ModelPicker, ShipBar's send menu,
// the mention menu, Onboarding and AuthDialog — rather than five components each inventing a
// `setTimeout` and one of them leaking it.

/** How long a closing overlay stays mounted. Matches `--dz-motion-fast` (120ms) with a couple of
 *  frames of slack so the animation is never cut off mid-way on a busy frame. */
const EXIT_MS = 140;

export interface Presence {
  /** Whether the node should be in the DOM — true while open AND while animating out. */
  mounted: () => boolean;
  /** True only during the exit window, for the stylesheet to hang a leave animation on. */
  leaving: () => boolean;
}

/**
 * Keep a node mounted through its exit animation.
 *
 * @param open the component's own open state
 * @param exitMs how long to stay mounted after `open` goes false
 */
export function createPresence(open: () => boolean, exitMs: number = EXIT_MS): Presence {
  const [leaving, setLeaving] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wasOpen = open();

  // `createComputed`, NOT `createEffect`, and the distinction is load-bearing in both directions:
  //
  //  • A render effect runs AFTER the pure computations, so `<Show when={mounted()}>` would
  //    re-evaluate on the close with `leaving` still false, unmount the node, and only then have
  //    the effect flip `leaving` — remounting it for 140ms. The menu visibly blinked out and
  //    back before finally going. A computed writes during the same propagation, so `mounted`
  //    never reads a torn state.
  //  • Only the CLOSE direction is stateful at all: `mounted` derives straight from `open`, so
  //    opening mounts in the same pass. Routing that through a signal cost a tick, and
  //    ModelPicker's open-focus effect then ran against a popover that did not exist yet and
  //    dropped focus on `<body>`. Its unit test caught that one.
  createComputed(() => {
    const isOpen = open();
    if (isOpen === wasOpen) return;
    wasOpen = isOpen;
    clearTimeout(timer);
    if (isOpen) {
      // Re-opening during the exit window cancels it, or the node unmounts out from under a menu
      // the user has just re-triggered.
      setLeaving(false);
      return;
    }
    setLeaving(true);
    timer = setTimeout(() => setLeaving(false), exitMs);
  });

  // Unmounting the OWNER mid-exit (switching surfaces while a menu closes) would otherwise leave
  // the timer to fire against a disposed scope.
  onCleanup(() => clearTimeout(timer));

  return { mounted: () => open() || leaving(), leaving };
}
