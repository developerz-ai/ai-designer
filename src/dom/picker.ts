import { getStyles } from '@/dom/read';
import { pickUnique, resolveSelector } from '@/dom/selector';
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
  /** Tear the shadow host out of the DOM (stops first). */
  destroy(): void;
}

/** Stable id + attribute on the shadow host — the recorder ignores `data-dz-designer` nodes. */
export const PICKER_HOST_ID = 'dz-designer-picker';

// Self-contained overlay chrome. These are NOT panel SCSS tokens (src/styles/_tokens.scss): the
// overlay lives in the page's world inside a shadow root and can't reach the panel's stylesheet,
// so its palette is defined here, CSS-isolated from both sides.
const HOST_STYLE =
  'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
const ACCENT = '#6366f1'; // indigo — hover outline
const SELECTED_COLOR = '#10b981'; // emerald — committed multi-selection
const FRAGILE_COLOR = '#f59e0b'; // amber — fragile-selector badge

const CSS = `
.dz-hover, .dz-box {
  position: fixed; top: 0; left: 0;
  box-sizing: border-box;
  pointer-events: none;
  border: 2px solid ${ACCENT};
  background: ${ACCENT}1f;
  border-radius: 2px;
  will-change: transform, width, height;
}
.dz-box { border-color: ${SELECTED_COLOR}; background: ${SELECTED_COLOR}1f; }
.dz-pill {
  position: fixed; top: 0; left: 0;
  pointer-events: none;
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 90vw;
  padding: 3px 7px;
  font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #f9fafb;
  background: #111827;
  border: 1px solid #374151;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.32);
  white-space: nowrap;
}
.dz-tag { color: #a5b4fc; font-weight: 600; }
.dz-dims { color: #9ca3af; }
.dz-sel { color: #e5e7eb; overflow: hidden; text-overflow: ellipsis; max-width: 40vw; }
.dz-badge {
  color: #111827; background: ${FRAGILE_COLOR};
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
  let hovered: Element | null = null;
  const selected = new Set<Element>();

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

  function renderSelected(): void {
    if (!ui) return;
    ui.selectedLayer.textContent = '';
    for (const target of selected) {
      const box = mkEl('div', 'dz-box');
      place(box, rectOf(target));
      ui.selectedLayer.appendChild(box);
    }
  }

  function clearSelected(): void {
    selected.clear();
    if (ui) ui.selectedLayer.textContent = '';
  }

  function pickSingle(target: Element): void {
    const hadMulti = selected.size > 0;
    clearSelected();
    if (hadMulti) emit({ type: 'multi-select-changed', selectors: [] });
    emit({
      type: 'element-picked',
      candidates: selectorsFor(target),
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

  const onOver = (e: MouseEvent): void => {
    const t = e.target;
    if (!(t instanceof Element) || isOwn(t)) return;
    hovered = t;
    renderHover(t);
  };

  const onClick = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const t = e.target;
    if (!(t instanceof Element) || isOwn(t)) return;
    // The pick click must never reach the page (no navigation, no page handlers).
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.shiftKey) toggleMulti(t);
    else pickSingle(t);
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
    doc.removeEventListener('keydown', onKeydown, true);
    doc.removeEventListener('scroll', onReflow, true);
    win?.removeEventListener('resize', onReflow);
    hovered = null;
    clearSelected();
    hideHover();
    emit({ type: 'picker-state', active: false });
  }

  function destroy(): void {
    stop();
    ui?.host.remove();
    ui = null;
  }

  return { start, stop, isActive: () => active, destroy };
}
