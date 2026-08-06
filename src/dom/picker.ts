import { getStyles } from '@/dom/read';
import { pickUnique, resolveSelector, xpathFor } from '@/dom/selector';
import type { ContentToSw, Rect, StableSelector } from '@/shared/messages';

// Cursor-style element picker overlay — the content script's user-driven "point at the thing"
// tool (docs/idea/ui.md "Element picker overlay"). Draws a hover outline + a floating pill
// (tag · dims · resolved stable selector · fragility badge) inside a shadow-DOM host so the
// page's CSS can't bleed into the chrome and ours can't leak onto the page. Click focuses one
// element for the agent; shift-click accumulates a multi-selection. Pure DOM (no chrome.*): the
// caller injects `emit`, so the module is jsdom-testable and the content entrypoint stays a thin
// wire that forwards emitted ContentToSw events over the bus. See docs/idea/live-edit.md.

/** Sink for the picker's `ContentToSw` events. The content script forwards these to the SW. */
export type PickerEmit = (msg: ContentToSw) => void;

export interface Picker {
  /** Activate hover/click tracking + mount the overlay. Idempotent. Emits `picker-state`. */
  start(): void;
  /** Deactivate + clear the overlay. Idempotent. Emits `picker-state`. */
  stop(): void;
  isActive(): boolean;
  /**
   * Drop ONE committed element from the selection, matched by its unique selector value — the
   * content-world half of a reference chip's dismiss. The panel cannot simply forget a reference
   * locally: `multi-select-changed` is the only write path into its multi-selection, so the very
   * next pick would echo the removed element straight back and the agent would be grounded on
   * something the user detached. Re-renders and emits the usual `multi-select-changed`; a value
   * that matches nothing is a no-op (and emits nothing).
   */
  deselect(value: string): void;
  /**
   * Commit ONE element to the selection by its unique selector value, with no pick gesture — the
   * content-world half of the composer's `@` menu. The mirror of {@link Picker.deselect}, and
   * necessary for the same reason: the panel cannot add locally, because the next
   * `multi-select-changed` echo is authoritative and would drop it. A value that matches nothing
   * in the document, or an element already selected, is a no-op (and emits nothing).
   */
  select(value: string): boolean;
  /**
   * Arm modifier-click quick-pick: {@link QUICK_PICK_MODIFIER}+click pins the clicked element as
   * chat context WITHOUT arming the full picker first, so "make THIS bigger" needs no mode switch
   * — you point at the thing while you are already looking at it. Emits the same `element-picked`
   * the armed picker does, so the panel's context chip needs no special case. Idempotent.
   */
  enableQuickPick(): void;
  /** Disarm modifier-click quick-pick. Idempotent. */
  disableQuickPick(): void;
  /** Tear the shadow host out of the DOM (stops first). */
  destroy(): void;
}

/**
 * The quick-pick chord: **Alt anywhere, or Ctrl outside a link**.
 *
 * Alt is the universal one — unbound in the browser, rare in page handlers, safe on every element
 * on every platform. Ctrl is accepted too because it is the chord people reach for (Cursor's
 * visual editor uses it), but it cannot be taken unconditionally: Ctrl+click is "open in a new
 * tab" on every link on the web, and on macOS it is a right-click synonym. So Ctrl picks
 * everything EXCEPT a link — where the browser's meaning wins and Alt is still available — and
 * never on macOS, where the whole chord belongs to the context menu.
 *
 * Both modifiers HIGHLIGHT while held; only the click is gated, since highlighting takes nothing
 * away from anyone.
 */
export function isQuickPickChord(
  e: { altKey: boolean; ctrlKey: boolean },
  target?: Element | null,
) {
  if (e.altKey) return true;
  if (!e.ctrlKey || isApplePlatform()) return false;
  // A link (or anything inside one) keeps Ctrl+click = open in a new tab.
  return !target?.closest?.('a[href]');
}

/** Whether Ctrl+click means "right-click" here (macOS and iPadOS). Read from the UA rather than
 *  the deprecated `navigator.platform` where available, and defaulted to `false` so a headless or
 *  exotic host keeps the more useful behaviour. */
function isApplePlatform(): boolean {
  const nav = globalThis.navigator as
    | (Navigator & { userAgentData?: { platform?: string } })
    | undefined;
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Whether a modifier that ARMS the hover highlight is currently down. Highlighting is free —
 *  it intercepts nothing — so both chords qualify regardless of platform or target. */
export function isQuickPickHoverChord(e: { altKey: boolean; ctrlKey: boolean }): boolean {
  return e.altKey || e.ctrlKey;
}

/** Stable id + attribute on the shadow host — the recorder ignores `data-dz-designer` nodes. */
export const PICKER_HOST_ID = 'dz-designer-picker';

// Self-contained overlay chrome. These are NOT panel SCSS tokens (src/styles/_tokens.scss): the
// overlay lives in the page's world inside a shadow root and can't reach the panel's stylesheet,
// so its palette is defined here, CSS-isolated from both sides.
const HOST_STYLE =
  'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
// Brand orange, matching --dz-accent in the panel. The picker used indigo for hover and emerald
// for a commit — three palettes across one feature, and neither of them ours. The panel's chips
// and these rectangles are now the same object seen twice, so they share a hue.
const ACCENT = '#f97316';
const ACCENT_INK = '#1a1205'; // legible on a solid accent badge
const FRAGILE_COLOR = '#fbbf24'; // amber — fragile selector, the one hue shift that means something
const FRAGILE_INK = '#221a05';
const SURFACE = '#171a21'; // panel card colour, for the hover badge
const SURFACE_INK = '#e6e8eb';
// Slightly longer than the 620ms fade so the box is removed after it has finished animating.
const FLASH_MS = 700;

// Hover vs pinned is a difference of WEIGHT, not hue: hover is a 1px dashed hairline with no
// fill (it follows the cursor, so a filled box would strobe across the page), pinned is a solid
// 2px edge with a 10% wash. Fragile keeps the dash and shifts to amber, so all three read at a
// glance without a legend.
const CSS = `
.dz-hover, .dz-box, .dz-flash {
  position: fixed; top: 0; left: 0;
  box-sizing: border-box;
  pointer-events: none;
  border-radius: 4px;
  will-change: transform, width, height;
}
.dz-hover {
  border: 1px dashed ${ACCENT}73;
  background: transparent;
}
.dz-box {
  border: 2px solid ${ACCENT};
  background: ${ACCENT}1a;
}
.dz-box--fragile {
  border-style: dashed;
  border-color: ${FRAGILE_COLOR};
  background: ${FRAGILE_COLOR}1a;
}
/* The index badge riding each pinned box — the same number its chip carries in the panel, so a
   user can tell which outline a chip is talking about without hovering anything. */
.dz-idx {
  position: absolute; top: -9px; left: -1px;
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 5px;
  font: 600 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: ${ACCENT_INK};
  background: ${ACCENT};
  border-radius: 4px;
  white-space: nowrap;
}
.dz-box--fragile .dz-idx { color: ${FRAGILE_INK}; background: ${FRAGILE_COLOR}; }
/* Quick-pick confirmation: the committed-selection box, faded out. Without it an Alt+click gave
   no on-page feedback at all — the only sign it registered was a chip in a panel the user was
   not looking at. Animation-only, pointer-events: none, removed on finish. */
.dz-flash {
  border: 2px solid ${ACCENT};
  background: ${ACCENT}2e;
  animation: dz-flash 620ms ease-out forwards;
}
@keyframes dz-flash {
  0% { opacity: 0; }
  18% { opacity: 1; }
  100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  /* Still confirm, just without the fade — hold it briefly, then remove (the JS timer owns
     teardown either way). */
  .dz-flash { animation: none; opacity: 1; }
}
.dz-pill {
  position: fixed; top: 0; left: 0;
  pointer-events: none;
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 90vw;
  padding: 3px 7px;
  font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: ${SURFACE_INK};
  background: ${SURFACE};
  border: 1px solid ${ACCENT}73;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.32);
  white-space: nowrap;
}
.dz-tag { color: ${ACCENT}; font-weight: 600; }
.dz-dims { color: #8b909a; }
.dz-sel { color: #c9cdd4; overflow: hidden; text-overflow: ellipsis; max-width: 40vw; }
.dz-badge {
  color: ${FRAGILE_INK}; background: ${FRAGILE_COLOR};
  padding: 0 5px; border-radius: 999px; font-weight: 700; font-size: 10px;
}
.dz-hidden { display: none !important; }
`;

interface Ui {
  host: HTMLElement;
  hover: HTMLElement;
  selectedLayer: HTMLElement;
  pill: HTMLElement;
  tag: HTMLElement;
  dims: HTMLElement;
  sel: HTMLElement;
  badge: HTMLElement;
}

/**
 * Build a picker bound to `doc` (a jsdom document in tests, the live page in the content script).
 * One instance per page; the content script owns it and drives start/stop from the panel's
 * picker commands.
 */
export function createPicker(emit: PickerEmit, doc: Document = document): Picker {
  const win = doc.defaultView;
  let ui: Ui | null = null;
  let active = false;
  let quickPick = false;
  let hovered: Element | null = null;
  const selected = new Set<Element>();
  // The single pinned element (a plain click in the armed picker), tracked separately from the
  // shift-multi set because the panel treats it the same way: `orderedReferences` puts it first.
  // It exists so the pin gets an outline and the badge numbering matches the chips.
  let pinned: Element | null = null;

  function mkEl(tag: string, className: string): HTMLElement {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  }

  function ensureUi(): Ui {
    if (ui) return ui;
    const host = doc.createElement('div');
    host.id = PICKER_HOST_ID;
    host.setAttribute('data-dz-designer', 'picker');
    host.style.cssText = HOST_STYLE;
    const root = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = CSS;
    const hover = mkEl('div', 'dz-hover dz-hidden');
    const selectedLayer = mkEl('div', 'dz-selected');
    const pill = mkEl('div', 'dz-pill dz-hidden');
    const tag = mkEl('span', 'dz-tag');
    const dims = mkEl('span', 'dz-dims');
    const sel = mkEl('span', 'dz-sel');
    const badge = mkEl('span', 'dz-badge');
    badge.textContent = 'fragile';
    pill.append(tag, dims, sel, badge);
    root.append(style, hover, selectedLayer, pill);
    (doc.body ?? doc.documentElement).appendChild(host);
    ui = { host, hover, selectedLayer, pill, tag, dims, sel, badge };
    return ui;
  }

  function isOwn(node: Element): boolean {
    return ui != null && (node === ui.host || ui.host.contains(node));
  }

  function docOf(target: Element): Document {
    return target.ownerDocument ?? doc;
  }

  function rectOf(target: Element): Rect {
    const r = target.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  // Winner (unique-resolving) selector first so `candidates[0]` is what the panel focuses; the
  // ranked alternates follow for the dev-agent's source-mapping. Deduped by value.
  function selectorsFor(target: Element): StableSelector[] {
    const winner = pickUnique(target, docOf(target));
    const rest = resolveSelector(target).filter((c) => c.value !== winner.value);
    return [winner, ...rest];
  }

  // Devtools-style label: tag, then #id and the first class if present (page-derived — set as
  // textContent, never innerHTML).
  function describeTag(target: Element): string {
    const tag = target.tagName.toLowerCase();
    const id = target.id ? `#${target.id}` : '';
    const cls = target.getAttribute('class')?.trim().split(/\s+/)[0];
    return `${tag}${id}${cls ? `.${cls}` : ''}`;
  }

  function place(box: HTMLElement, rect: Rect): void {
    box.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  // Pill sits above the element, flipping below when it would clip the top edge.
  function placePill(rect: Rect): void {
    if (!ui) return;
    const below = rect.y < 26;
    ui.pill.style.left = `${Math.max(2, rect.x)}px`;
    ui.pill.style.top = `${below ? rect.y + rect.height + 4 : rect.y - 4}px`;
    ui.pill.style.transform = below ? 'none' : 'translateY(-100%)';
  }

  function renderHover(target: Element): void {
    if (!ui) return;
    const rect = rectOf(target);
    place(ui.hover, rect);
    ui.hover.classList.remove('dz-hidden');
    const sel = pickUnique(target, docOf(target));
    ui.tag.textContent = describeTag(target);
    ui.dims.textContent = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
    ui.sel.textContent = sel.value;
    ui.badge.classList.toggle('dz-hidden', !sel.fragile);
    placePill(rect);
    ui.pill.classList.remove('dz-hidden');
  }

  function hideHover(): void {
    if (!ui) return;
    ui.hover.classList.add('dz-hidden');
    ui.pill.classList.add('dz-hidden');
  }

  /** Draw one numbered outline. Split out of `renderSelected` so the pin and the multi-selection
   *  are drawn by the same code — two renderers would drift, and this one owns the numbering
   *  contract the panel's chips depend on. */
  function drawBox(target: Element, index: number): void {
    if (!ui) return;
    const sel = pickUnique(target, docOf(target));
    // Amber + dashed when the only selector we could find is brittle: the warning belongs on
    // the page, next to the element, not only in a chip the user is not looking at.
    const box = mkEl('div', `dz-box${sel.fragile ? ' dz-box--fragile' : ''}`);
    place(box, rectOf(target));
    // `2 · section.hero` — the index ties this outline to its panel chip, the tag says what was
    // actually caught. textContent, never innerHTML: the tag string is page-derived.
    const idx = mkEl('span', 'dz-idx');
    idx.textContent = `${sel.fragile ? '⚠ ' : ''}${index} · ${describeTag(target)}`;
    box.appendChild(idx);
    ui.selectedLayer.appendChild(box);
  }

  /**
   * Repaint every committed outline.
   *
   * The numbering here is a CONTRACT with the panel: `stores/focus.ts` `orderedReferences` puts
   * the single pin first and the shift-multi set after it, and the chips are numbered off that
   * list. So the pin is box 1 and the multi set starts at 2. Numbering the multi set from 1 and
   * drawing no box at all for the pin (which is what this did) meant every badge on the page was
   * off by one against the chips it was supposed to identify — the exact confusion the badge
   * exists to remove.
   */
  function renderSelected(): void {
    if (!ui) return;
    ui.selectedLayer.textContent = '';
    // A pin that was later shift-toggled into the multi set must not be drawn twice.
    const pin = pinned && !selected.has(pinned) ? pinned : null;
    // One flat list, numbered by position — the same shape `orderedReferences` builds in the
    // panel, so the two cannot drift apart as either side is edited later.
    const ordered = pin ? [pin, ...selected] : [...selected];
    ordered.forEach((target, i) => {
      drawBox(target, i + 1);
    });
  }

  function clearSelected(): void {
    selected.clear();
    pinned = null;
    if (ui) ui.selectedLayer.textContent = '';
  }

  /** Content-world half of a chip's dismiss — see the `deselect` doc on {@link Picker}. */
  function deselect(value: string): void {
    if (pinned && pickUnique(pinned, docOf(pinned)).value === value) {
      pinned = null;
      renderSelected();
      // The pin is not part of `selected`, so there is no multi-selection change to announce —
      // the panel drops its own pin the moment the chip is dismissed.
      return;
    }
    const hit = [...selected].find((el) => pickUnique(el, docOf(el)).value === value);
    if (!hit) return;
    selected.delete(hit);
    renderSelected();
    emitMultiSelect();
  }

  /** Content-world half of an `@` mention — see the `select` doc on {@link Picker}. Resolves the
   *  value against the live document rather than trusting a remembered node, so a mention of an
   *  element the page has since re-rendered away is a clean no-op instead of a stale reference. */
  function select(value: string): boolean {
    // `querySelector`, not a remembered node: a mention may name an element the page has since
    // re-rendered away, and a bad selector must be a no-op rather than a throw that kills the
    // picker. Shadow-piercing values (`>>>`) are deliberately not resolved here — those come from
    // a real pick, which already put the element in `selected`.
    let el: Element | null = null;
    try {
      el = doc.querySelector(value);
    } catch {
      return false;
    }
    if (!el || selected.has(el)) return false;
    selected.add(el);
    renderSelected();
    emitMultiSelect();
    return true;
  }

  /** Briefly outline `target` to confirm a quick pick landed. Mounts the shadow host if needed —
   *  the armed picker is not running, so nothing else has — and tears the box out again on a
   *  timer, so the page is left exactly as it was found. */
  function flash(target: Element): void {
    const layer = ensureUi().selectedLayer;
    const box = mkEl('div', 'dz-flash');
    place(box, rectOf(target));
    layer.appendChild(box);
    win?.setTimeout(() => box.remove(), FLASH_MS);
  }

  // --- quick-pick hover: highlight what a modifier-click WOULD take ---------
  // Holding the modifier turns the page into a target picker for as long as it is down: the
  // element under the pointer gets the same outline + selector pill the armed picker draws. This
  // is the half that makes quick-pick usable — without it you click blind and only find out what
  // you hit afterwards, which is exactly what "how does the agent know what I mean?" is asking.

  let hoverArmed = false;
  // Last known pointer position, tracked passively while quick-pick is enabled. Needed because
  // `mouseover` only fires when the pointer MOVES: hold the modifier without moving the mouse and
  // there is no event to hang the first outline on, so the feature looked dead until you jiggled
  // the mouse. Two numbers on a passive listener, and they let `armHover` resolve what is already
  // under the cursor.
  let pointerX = 0;
  let pointerY = 0;

  const onPointerTrack = (e: MouseEvent): void => {
    pointerX = e.clientX;
    pointerY = e.clientY;
  };

  function armHover(): void {
    if (hoverArmed || active) return;
    hoverArmed = true;
    ensureUi();
    doc.addEventListener('mouseover', onOver, true);
    doc.addEventListener('scroll', onReflow, true);
    win?.addEventListener('resize', onReflow);
    // Outline whatever is under the cursor RIGHT NOW, without waiting for the next move.
    const under = (doc as Document).elementFromPoint?.(pointerX, pointerY) ?? null;
    if (under && !isOwn(under)) {
      hovered = under;
      renderHover(under);
    }
  }

  function disarmHover(): void {
    if (!hoverArmed) return;
    hoverArmed = false;
    doc.removeEventListener('mouseover', onOver, true);
    doc.removeEventListener('scroll', onReflow, true);
    win?.removeEventListener('resize', onReflow);
    hovered = null;
    hideHover();
  }

  const onModifierDown = (e: KeyboardEvent): void => {
    if (isQuickPickHoverChord(e)) armHover();
  };

  const onModifierUp = (e: KeyboardEvent): void => {
    if (!isQuickPickHoverChord(e)) disarmHover();
  };

  // Alt+Tab / clicking away leaves the keyup unheard, which would strand the outline on the page
  // with no way to clear it. Any focus loss disarms.
  const onWindowBlur = (): void => disarmHover();

  function pickSingle(target: Element): void {
    const hadMulti = selected.size > 0;
    clearSelected();
    if (hadMulti) emit({ type: 'multi-select-changed', selectors: [] });
    // Only the ARMED picker leaves a persistent outline. A quick pick (Alt+click) is a one-shot
    // gesture on a page the user is reading, and its confirmation is the flash below — a box that
    // stayed behind would be litter on a page nobody asked to annotate.
    if (active) {
      pinned = target;
      renderSelected();
    }
    emit({
      type: 'element-picked',
      candidates: selectorsFor(target),
      xpath: xpathFor(target),
      rect: rectOf(target),
      styles: getStyles(target).styles,
    });
  }

  // Panel resync: the emitted selector set mirrors `selected`. Emit only after a mutation.
  function emitMultiSelect(): void {
    emit({
      type: 'multi-select-changed',
      selectors: [...selected].map((s) => pickUnique(s, docOf(s))),
    });
  }

  function toggleMulti(target: Element): void {
    if (selected.has(target)) selected.delete(target);
    else selected.add(target);
    renderSelected();
    emitMultiSelect();
  }

  // The event's TRUE origin, piercing shadow boundaries. A composed event that crossed a shadow
  // root is retargeted to the outermost host by the time it reaches this `document` listener, so
  // `e.target` names the custom element and never the inner node the user is pointing at (#165
  // F4) — `composedPath()[0]` is the node actually under the cursor. Falls back to `target` for a
  // synthetic event with no composed path.
  function targetOf(e: Event): Element | null {
    const first = e.composedPath?.()[0] ?? e.target;
    return first instanceof Element ? first : null;
  }

  const onOver = (e: MouseEvent): void => {
    const t = targetOf(e);
    if (!t || isOwn(t)) return;
    hovered = t;
    renderHover(t);
  };

  const onClick = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const t = targetOf(e);
    if (!t || isOwn(t)) return;
    // The pick click must never reach the page (no navigation, no page handlers).
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.shiftKey) toggleMulti(t);
    else pickSingle(t);
  };

  // Cancelling `click` alone is not enough to keep the picker read-only (#165 F3): a
  // mousedown/mouseup pair IS a drag on an HTML5 drag-and-drop board (Trello/Jira-style), so a
  // shift-click multi-selection would drop a card into another column, and a mousedown-routed nav
  // would navigate. None of that is a recorder event, so nothing could undo it. Swallow the whole
  // gesture in the capture phase. Cancelling `pointerdown` also suppresses the compatibility mouse
  // events per Pointer Events — `click` still fires, which is what `onClick` picks on.
  const SWALLOWED = [
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'dblclick',
    'contextmenu',
  ] as const;

  const onSwallow = (e: Event): void => {
    const t = targetOf(e);
    if (!t || isOwn(t)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      stop();
    }
  };

  // Outlines are viewport-fixed, so they must follow the page as it scrolls / resizes. A removed
  // target drops its outline (mirrors overlay.onReflow) rather than pinning a stale 0×0 box at origin.
  const onReflow = (): void => {
    if (hovered) {
      if (hovered.isConnected) renderHover(hovered);
      else {
        hideHover();
        hovered = null;
      }
    }
    let pruned = false;
    for (const target of selected)
      if (!target.isConnected) {
        selected.delete(target);
        pruned = true;
      }
    renderSelected();
    // Pruning changed the selector set — resync the panel so it drops selectors for elements
    // that left the DOM. Stay silent when nothing was pruned.
    if (pruned) emitMultiSelect();
  };

  function start(): void {
    if (active) return;
    active = true;
    ensureUi();
    doc.addEventListener('mouseover', onOver, true);
    doc.addEventListener('click', onClick, true);
    for (const type of SWALLOWED) doc.addEventListener(type, onSwallow, true);
    doc.addEventListener('keydown', onKeydown, true);
    doc.addEventListener('scroll', onReflow, true);
    win?.addEventListener('resize', onReflow);
    emit({ type: 'picker-state', active: true });
  }

  function stop(): void {
    if (!active) return;
    active = false;
    doc.removeEventListener('mouseover', onOver, true);
    doc.removeEventListener('click', onClick, true);
    for (const type of SWALLOWED) doc.removeEventListener(type, onSwallow, true);
    doc.removeEventListener('keydown', onKeydown, true);
    doc.removeEventListener('scroll', onReflow, true);
    win?.removeEventListener('resize', onReflow);
    hovered = null;
    clearSelected();
    hideHover();
    emit({ type: 'picker-state', active: false });
  }

  // --- modifier-click quick pick ------------------------------------------
  // Always listening once enabled (the armed picker is not involved), so the cost when the
  // modifier is not held is one capture-phase comparison per click.

  const onQuickPick = (e: MouseEvent): void => {
    // The armed picker owns every click while it is up — let its handler run instead of both.
    if (active || e.button !== 0) return;
    const t = targetOf(e);
    if (!t || isOwn(t) || !isQuickPickChord(e, t)) return;
    // Same read-only contract as the armed picker: the pick gesture must not reach the page.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    pickSingle(t);
    disarmHover();
    flash(t);
  };

  // A modifier-click still starts a native drag on an HTML5 drag-and-drop board, and `mousedown`
  // routes navigation on some apps — neither is a recorder event, so nothing could undo it.
  // Swallow the rest of the gesture too, but ONLY when the modifier is held (unmodified clicks
  // must pass through untouched — this listener is live on every page).
  const onQuickPickSwallow = (e: MouseEvent): void => {
    if (active || e.button !== 0) return;
    const t = targetOf(e);
    if (!t || isOwn(t) || !isQuickPickChord(e, t)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const QUICK_SWALLOWED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup'] as const;

  function enableQuickPick(): void {
    if (quickPick) return;
    quickPick = true;
    doc.addEventListener('click', onQuickPick, true);
    for (const type of QUICK_SWALLOWED) {
      doc.addEventListener(type, onQuickPickSwallow as EventListener, true);
    }
    doc.addEventListener('keydown', onModifierDown, true);
    doc.addEventListener('keyup', onModifierUp, true);
    doc.addEventListener('pointermove', onPointerTrack as EventListener, {
      capture: true,
      passive: true,
    });
    win?.addEventListener('blur', onWindowBlur);
  }

  function disableQuickPick(): void {
    if (!quickPick) return;
    quickPick = false;
    doc.removeEventListener('click', onQuickPick, true);
    for (const type of QUICK_SWALLOWED) {
      doc.removeEventListener(type, onQuickPickSwallow as EventListener, true);
    }
    doc.removeEventListener('keydown', onModifierDown, true);
    doc.removeEventListener('keyup', onModifierUp, true);
    doc.removeEventListener('pointermove', onPointerTrack as EventListener, true);
    win?.removeEventListener('blur', onWindowBlur);
    disarmHover();
  }

  function destroy(): void {
    stop();
    disableQuickPick();
    ui?.host.remove();
    ui = null;
  }

  return {
    start,
    stop,
    isActive: () => active,
    deselect,
    select,
    enableQuickPick,
    disableQuickPick,
    destroy,
  };
}
