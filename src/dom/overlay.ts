import { resolveShadowSelector } from '@/dom/selector';
import type { Rect } from '@/shared/messages';

// Agent-decision overlay — the content script's opt-in "watch the agent work" surface (slice 09,
// docs/idea/ui.md "a bit overlay on the site … see how the agent operates"). While a turn runs it
// paints, inside a shadow-DOM host, a compact card: the current step ("querying .hero",
// "setStyle → padding"), a short scrolling log of the last few steps, and a highlight box on the
// element the agent is acting on. The highlight deliberately reuses the picker's visual language
// (docs/idea/live-edit.md "Element picker overlay", src/dom/picker.ts) — same outline box +
// transform-positioned rect — so the on-page chrome reads as one Cursor-style system.
//
// It NEVER blocks the page: the host and everything in it are `pointer-events: none`, so the user
// keeps interacting with the site while watching. Pure DOM (no chrome.*, no bus): the content
// entrypoint owns one instance and drives enable/disable/step from the SW's forwarded stream, so
// the module is jsdom-testable and the entrypoint stays a thin wire. Disabled = the host is gone
// from the DOM entirely (toggle off removes it), never merely hidden.

/** Accent for a step — `read`/`info` outline in indigo (like the picker's hover), `act` in emerald
 *  (like the picker's committed selection). Purely cosmetic; the overlay is agnostic to semantics. */
export type OverlayStepKind = 'read' | 'act' | 'info';

/** One agent step to surface. The caller (SW→overlay mapping) composes `label` from the tool call;
 *  the overlay just renders it + highlights the target, staying decoupled from the message schema. */
export interface OverlayStep {
  /** Human-legible current action, e.g. `querying .hero` or `setStyle → padding`. Rendered as text
   *  (never HTML), so a page-derived selector in it can't inject markup. */
  label: string;
  /** Selector of the element under action — highlighted when it resolves. Supports the shadow
   *  engine's ` >>> ` piercing combinator (src/dom/selector.ts); a plain selector is one hop. */
  selector?: string;
  /** Pre-resolved geometry. When present it wins over `selector` (the caller already has the rect,
   *  e.g. from an `element-picked`); a static rect isn't re-placed on scroll. */
  rect?: Rect;
  /** Cosmetic accent — defaults to `info`. */
  kind?: OverlayStepKind;
}

export interface Overlay {
  /** Mount the shadow host + start tracking scroll/resize. Idempotent. */
  enable(): void;
  /** Unmount the host (removed from the DOM — disabled adds nothing to the page) + stop tracking.
   *  Idempotent. */
  disable(): void;
  isEnabled(): boolean;
  /** Toggle, or force to `on` when given. */
  toggle(on?: boolean): void;
  /** Set the current step: banner text + log entry + target highlight. No-op while disabled. */
  step(step: OverlayStep): void;
  /** Reset the banner to idle, empty the log, hide the highlight (stays enabled). */
  clear(): void;
  /** Full teardown (page unload): unmount + drop all references. */
  destroy(): void;
}

/** Stable id + marker attribute on the shadow host — matches the picker so page reads/screenshots
 *  and the recorder treat `data-dz-designer` nodes as our chrome, not page content. */
export const OVERLAY_HOST_ID = 'dz-designer-overlay';

/** Newest-first; older steps fall off the tail. */
const MAX_LOG = 6;
const IDLE_LABEL = 'ready';

// Self-contained palette — the overlay lives in the page's world inside a shadow root and can't
// reach the panel's SCSS tokens (src/styles/_tokens.scss), so its colours are defined here,
// CSS-isolated from both sides. Mirrors the picker's hover/selected hues.
const READ = '#6366f1'; // indigo — read/query + default outline
const ACT = '#10b981'; // emerald — mutate/act outline + live dot
const HOST_STYLE =
  // One below the picker's max z-index so the user-driven picker always sits on top of the overlay.
  'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;';

const CSS = `
.dz-mark {
  position: fixed; top: 0; left: 0;
  box-sizing: border-box;
  pointer-events: none;
  border: 2px solid ${READ};
  background: ${READ}1f;
  border-radius: 2px;
  transition: transform 90ms ease-out, width 90ms ease-out, height 90ms ease-out;
  will-change: transform, width, height;
}
.dz-mark.dz-act { border-color: ${ACT}; background: ${ACT}1f; }
.dz-card {
  position: fixed; left: 16px; bottom: 16px;
  box-sizing: border-box;
  pointer-events: none;
  width: 320px; max-width: calc(100vw - 32px);
  padding: 10px 12px;
  font: 500 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #e5e7eb;
  background: rgba(17, 24, 39, 0.95);
  border: 1px solid #374151;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.36);
}
.dz-head { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
.dz-dot {
  width: 8px; height: 8px; border-radius: 999px;
  background: ${ACT}; box-shadow: 0 0 0 3px ${ACT}33;
  animation: dz-pulse 1.4s ease-in-out infinite;
}
.dz-title {
  color: #9ca3af; font-weight: 600; font-size: 11px;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.dz-now {
  display: block;
  color: #f9fafb; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border-left: 2px solid ${READ}; padding-left: 8px;
}
.dz-now.dz-act { border-left-color: ${ACT}; }
.dz-log { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.dz-log-item {
  color: #9ca3af; font-size: 11px; opacity: 0.85;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dz-hidden { display: none !important; }
@keyframes dz-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
`;

interface Ui {
  host: HTMLElement;
  mark: HTMLElement;
  now: HTMLElement;
  log: HTMLElement;
}

/**
 * Build an overlay bound to `doc` (a jsdom document in tests, the live page in the content script).
 * One instance per page; the content script owns it and drives enable/disable/step from the SW's
 * forwarded agent stream.
 */
export function createOverlay(doc: Document = document): Overlay {
  const win = doc.defaultView;
  let ui: Ui | null = null;
  let enabled = false;
  // The element currently outlined, kept so scroll/resize re-place its box (a static `rect` step
  // leaves this null — there's no live element to re-measure).
  let highlighted: Element | null = null;

  function mkEl(tag: string, className: string): HTMLElement {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  }

  function ensureUi(): Ui {
    if (ui) return ui;
    const host = doc.createElement('div');
    host.id = OVERLAY_HOST_ID;
    host.setAttribute('data-dz-designer', 'overlay');
    host.style.cssText = HOST_STYLE;
    const root = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = CSS;

    const mark = mkEl('div', 'dz-mark dz-hidden');
    const card = mkEl('div', 'dz-card');
    const head = mkEl('div', 'dz-head');
    const dot = mkEl('span', 'dz-dot');
    const title = mkEl('span', 'dz-title');
    title.textContent = 'Designer';
    head.append(dot, title);
    const now = mkEl('span', 'dz-now');
    now.textContent = IDLE_LABEL;
    const log = mkEl('ul', 'dz-log');
    card.append(head, now, log);

    root.append(style, mark, card);
    (doc.body ?? doc.documentElement).appendChild(host);
    ui = { host, mark, now, log };
    return ui;
  }

  function isOwn(node: Element): boolean {
    return ui != null && (node === ui.host || ui.host.contains(node));
  }

  function rectOf(el: Element): Rect {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function place(rect: Rect): void {
    if (!ui) return;
    ui.mark.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    ui.mark.style.width = `${rect.width}px`;
    ui.mark.style.height = `${rect.height}px`;
  }

  function showMark(rect: Rect, act: boolean): void {
    if (!ui) return;
    place(rect);
    ui.mark.classList.toggle('dz-act', act);
    ui.mark.classList.remove('dz-hidden');
  }

  function hideMark(): void {
    highlighted = null;
    if (ui) ui.mark.classList.add('dz-hidden');
  }

  function highlight(target: OverlayStep): void {
    const act = target.kind === 'act';
    if (target.rect) {
      highlighted = null;
      showMark(target.rect, act);
      return;
    }
    if (target.selector) {
      const el = resolveShadowSelector(doc, target.selector);
      if (el && !isOwn(el)) {
        highlighted = el;
        showMark(rectOf(el), act);
        return;
      }
    }
    hideMark();
  }

  // Outline is viewport-fixed, so it follows the page as it scrolls / resizes. A removed target
  // drops the outline rather than pinning a stale box.
  const onReflow = (): void => {
    if (!ui || !highlighted) return;
    if (!highlighted.isConnected) {
      hideMark();
      return;
    }
    place(rectOf(highlighted));
  };

  function enable(): void {
    if (enabled) return;
    enabled = true;
    ensureUi();
    doc.addEventListener('scroll', onReflow, true);
    win?.addEventListener('resize', onReflow);
  }

  function disable(): void {
    if (!enabled) return;
    enabled = false;
    doc.removeEventListener('scroll', onReflow, true);
    win?.removeEventListener('resize', onReflow);
    highlighted = null;
    ui?.host.remove();
    ui = null;
  }

  function step(s: OverlayStep): void {
    if (!enabled || !ui) return;
    const act = s.kind === 'act';
    ui.now.textContent = s.label;
    ui.now.classList.toggle('dz-act', act);

    const item = mkEl('li', 'dz-log-item');
    item.textContent = s.label;
    ui.log.insertBefore(item, ui.log.firstChild);
    while (ui.log.childElementCount > MAX_LOG) {
      const last = ui.log.lastElementChild;
      if (!last) break;
      last.remove();
    }

    highlight(s);
  }

  function clear(): void {
    if (!ui) return;
    ui.now.textContent = IDLE_LABEL;
    ui.now.classList.remove('dz-act');
    ui.log.textContent = '';
    hideMark();
  }

  return {
    enable,
    disable,
    isEnabled: () => enabled,
    toggle: (on?: boolean) => ((on ?? !enabled) ? enable() : disable()),
    step,
    clear,
    destroy: disable,
  };
}
