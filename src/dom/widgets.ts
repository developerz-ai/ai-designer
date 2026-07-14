import { queryAll, queryOne } from '@/dom/read';
import { resolveShadowSelector } from '@/dom/selector';
import type { ToolResult, WidgetActed, WidgetRecipe } from '@/shared/messages';

// Complex-widget interaction recipes (slice 15D) — the content script's "drive a web-component widget
// like a user" half. A single click/type can't operate a datetime picker, combobox, slider, modal,
// tab set, carousel, or drag-drop; each needs a SEQUENCE anchored on the widget's ARIA contract
// (role=combobox/listbox/slider/dialog/tab/gridcell), which survives restyling. Pure DOM + injected
// window/document (no chrome.*), so every recipe runs under jsdom and the content entrypoint stays a
// thin wire (coverage-excluded). Events mirror src/dom/interact.ts (realistic pointer/mouse/keyboard
// so framework listeners react); resolution is shadow-aware (a ` >>> ` host-path resolves via the
// slice-15B selector engine). An unmatched selector is an error ToolResult, never a throw.

const MAX_STEPS = 64;
const MAX_NAV = 24; // datetime month-navigation cap
const MAX_SLIDER_PRESSES = 200; // arrow-key stepping cap
const DEFAULT_SETTLE_MS = 2000;

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

export interface WidgetDeps {
  readonly doc?: Document;
  readonly win?: Window;
  /** Bounded async settle for content that renders after an interaction (a combobox's options, a
   *  calendar grid). Resolves `true` as soon as `predicate` holds, `false` at `timeoutMs`. Injectable
   *  so tests run synchronously; the default polls the DOM. */
  readonly settle?: (predicate: () => boolean, timeoutMs?: number) => Promise<boolean>;
}

export interface WidgetDriver {
  /** Run one ARIA-anchored recipe. `signal` short-circuits a pending settle (aborts the turn). */
  run(recipe: WidgetRecipe, signal?: AbortSignal): Promise<ToolResult>;
}

// --- event firing (jsdom-safe; mirrors src/dom/interact.ts) ----------------

function firePointer(el: Element, type: string, bubbles = true): void {
  if (typeof PointerEvent === 'function') {
    el.dispatchEvent(
      new PointerEvent(type, { bubbles, cancelable: true, pointerType: 'mouse', isPrimary: true }),
    );
  } else {
    el.dispatchEvent(new MouseEvent(type, { bubbles, cancelable: true }));
  }
}

function fireMouse(el: Element, type: string, bubbles = true): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles, cancelable: true }));
}

function fireKey(el: Element, type: string, key: string): boolean {
  return el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
}

function focus(el: Element): void {
  if (el instanceof HTMLElement) {
    try {
      el.focus();
    } catch {
      // focus() can throw on a detached/hidden element — the action still stands.
    }
  }
}

function scrollIntoView(el: Element): void {
  if (el instanceof HTMLElement && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  }
}

// Real user click order: pointer/mouse down -> focus -> up -> click (+ the element's default action).
function clickEl(el: Element): void {
  scrollIntoView(el);
  firePointer(el, 'pointerdown');
  fireMouse(el, 'mousedown');
  focus(el);
  firePointer(el, 'pointerup');
  fireMouse(el, 'mouseup');
  if (el instanceof HTMLElement) el.click();
  else fireMouse(el, 'click');
}

function pressOn(el: Element, key: string): void {
  focus(el);
  fireKey(el, 'keydown', key);
  if ([...key].length === 1) fireKey(el, 'keypress', key);
  fireKey(el, 'keyup', key);
}

// Set `.value` through the prototype's native setter so React/Vue value tracking observes the change.
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  focus(el);
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(
    typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true })
      : new Event('input', { bubbles: true }),
  );
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// --- resolution + ARIA reads ----------------------------------------------

// Shadow-aware element resolution: a ` >>> ` host-path replays through the slice-15B selector engine;
// a plain selector is a scoped `querySelector`.
function resolveTarget(doc: Document, selector: string): Element | null {
  return selector.includes('>>>') ? resolveShadowSelector(doc, selector) : queryOne(doc, selector);
}

function labelOf(el: Element): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
}

function isChecked(el: Element): boolean {
  if (el instanceof HTMLInputElement) return el.checked;
  return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
}

function num(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

// --- result helpers -------------------------------------------------------

function acted(
  widget: string,
  reached: boolean,
  steps: string[],
  state?: Record<string, string>,
): ToolResult {
  const data: WidgetActed = {
    widget,
    reached,
    steps: steps.slice(0, MAX_STEPS),
    ...(state ? { state } : {}),
  };
  return { type: 'tool-result', ok: true, data };
}

function fail(error: string): ToolResult {
  return { type: 'tool-result', ok: false, error };
}

function notFound(selector: string): ToolResult {
  return fail(`No element matches selector: ${selector}`);
}

// --- widget lookups -------------------------------------------------------

function findDialog(doc: Document): Element | null {
  return queryOne(doc, '[role="dialog"], [role="alertdialog"], dialog[open]');
}

function findButton(scope: ParentNode, re: RegExp): Element | null {
  const buttons = queryAll(
    scope,
    'button, [role="button"], input[type="button"], input[type="submit"]',
  );
  return buttons.find((b) => re.test(labelOf(b))) ?? null;
}

function resolveListbox(doc: Document, input: Element): ParentNode {
  const owned = input.getAttribute('aria-controls') ?? input.getAttribute('aria-owns');
  if (owned) {
    const el = doc.getElementById(owned);
    if (el) return el;
  }
  const combo = input.closest('[role="combobox"]');
  return combo?.querySelector('[role="listbox"]') ?? queryOne(doc, '[role="listbox"]') ?? doc;
}

function optionEls(scope: ParentNode): Element[] {
  return queryAll(scope, '[role="option"]');
}

function findCalendar(doc: Document): Element | null {
  return (
    queryOne(doc, '[role="grid"]') ??
    queryOne(doc, '[role="dialog"], [role="application"], .calendar, .datepicker')
  );
}

// Parse the calendar's visible month/year from its caption/heading/live region. Best-effort — an
// unparseable label returns null (navigation is then skipped; the day is picked in whatever is shown).
function readCalMonth(cal: Element): { year: number; month: number } | null {
  const text = (cal.textContent ?? '').toLowerCase();
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  if (!yearMatch) return null;
  const monthIndex = MONTHS.findIndex((m) => text.includes(m));
  if (monthIndex < 0) return null;
  return { year: Number(yearMatch[0]), month: monthIndex + 1 };
}

function navButton(cal: Element, re: RegExp): Element | null {
  const buttons = queryAll(cal, 'button, [role="button"], a');
  return (
    buttons.find((b) =>
      re.test(
        b.getAttribute('aria-label') ?? b.getAttribute('title') ?? `${labelOf(b)} ${b.className}`,
      ),
    ) ?? null
  );
}

function dayCells(cal: Element): Element[] {
  const cells = queryAll(cal, '[role="gridcell"]');
  return cells.length > 0 ? cells : queryAll(cal, 'td button, button[data-day], .day');
}

function isPickableDay(cell: Element): boolean {
  if (cell.getAttribute('aria-disabled') === 'true' || cell.hasAttribute('disabled')) return false;
  if (cell.getAttribute('aria-hidden') === 'true') return false;
  const cls = cell.className.toLowerCase();
  return !cls.includes('outside') && !cls.includes('adjacent') && !cls.includes('other-month');
}

function carouselControl(root: Element, direction: 'next' | 'prev'): Element | null {
  const re = direction === 'next' ? /next/i : /prev|previous/i;
  const controls = queryAll(root, 'button, [role="button"], a');
  const byLabel = controls.find((c) =>
    re.test(
      c.getAttribute('aria-label') ?? c.getAttribute('title') ?? `${labelOf(c)} ${c.className}`,
    ),
  );
  if (byLabel) return byLabel;
  const sel =
    direction === 'next'
      ? '.carousel-control-next, [data-slide="next"], [data-bs-slide="next"]'
      : '.carousel-control-prev, [data-slide="prev"], [data-bs-slide="prev"]';
  return queryOne(root, sel);
}

// --- HTML5 drag-drop ------------------------------------------------------

function makeDataTransfer(): DataTransfer | undefined {
  return typeof DataTransfer === 'function' ? new DataTransfer() : undefined;
}

function fireDrag(el: Element, type: string, dataTransfer: DataTransfer | undefined): void {
  if (typeof DragEvent === 'function') {
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
  } else {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  }
}

function defaultSettle(
  win: Window,
): (predicate: () => boolean, timeoutMs?: number) => Promise<boolean> {
  return (predicate, timeoutMs = DEFAULT_SETTLE_MS): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (predicate()) {
        resolve(true);
        return;
      }
      const startedAt = win.performance?.now?.() ?? 0;
      const tick = (): void => {
        if (predicate()) {
          resolve(true);
        } else if ((win.performance?.now?.() ?? 0) - startedAt >= timeoutMs) {
          resolve(false);
        } else {
          win.setTimeout(tick, 30);
        }
      };
      win.setTimeout(tick, 30);
    });
}

export function createWidgetDriver(deps: WidgetDeps = {}): WidgetDriver {
  const doc = deps.doc ?? document;
  const win = deps.win ?? doc.defaultView ?? window;
  const settle = deps.settle ?? defaultSettle(win);

  const aborted = (signal?: AbortSignal): boolean => signal?.aborted ?? false;

  function toggle(el: Element, on: boolean, steps: string[]): ToolResult {
    if (isChecked(el) !== on) {
      clickEl(el);
      steps.push(`click toggle -> ${on ? 'on' : 'off'}`);
    } else {
      steps.push('already in target state');
    }
    const now = isChecked(el);
    return acted('toggle', now === on, steps, { on: String(now) });
  }

  function tabs(root: Element, value: string, steps: string[]): ToolResult {
    let candidates = queryAll(root, '[role="tab"]');
    if (candidates.length === 0) {
      candidates = queryAll(root, '[role="button"][aria-controls], [aria-expanded]');
    }
    if (candidates.length === 0 && root.getAttribute('role') === 'tab') candidates = [root];
    if (candidates.length === 0) return fail('No tabs/accordion controls under the selector');

    const idx = Number(value);
    const byLabel = candidates.find((t) => labelOf(t).toLowerCase() === value.toLowerCase());
    const byIndex = Number.isInteger(idx) && idx >= 0 ? candidates[idx] : undefined;
    const byIncludes = candidates.find((t) =>
      labelOf(t).toLowerCase().includes(value.toLowerCase()),
    );
    const target = byLabel ?? byIndex ?? byIncludes;
    if (!target) return fail(`No tab matches "${value}"`);

    clickEl(target);
    steps.push(`select tab "${labelOf(target)}"`);
    // `reached` reflects the APP's observable response to the click (aria-selected / aria-expanded /
    // an active-tab class), never a status the driver writes itself — so the agent gets an honest
    // signal and can fall back to vision when a tab widget doesn't reflect its state.
    const reached =
      target.getAttribute('aria-selected') === 'true' ||
      target.getAttribute('aria-expanded') === 'true' ||
      /(^|\s)(active|selected)(\s|$)/.test(target.className);
    return acted('tabs', reached, steps, { selected: labelOf(target) });
  }

  async function modal(
    el: Element,
    action: 'open' | 'confirm' | 'dismiss',
    steps: string[],
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (action === 'open') {
      clickEl(el);
      steps.push('click trigger');
      if (aborted(signal)) return fail('aborted');
      await settle(() => findDialog(doc) !== null);
      const dlg = findDialog(doc);
      if (dlg) {
        focus(findFocusable(dlg) ?? dlg); // focus-trap entry point
        steps.push('focus dialog');
      }
      return acted('modal', dlg !== null, steps, { open: String(dlg !== null) });
    }

    const roleAttr = el.getAttribute('role') ?? '';
    const dlg = roleAttr.includes('dialog')
      ? el
      : (el.closest('[role="dialog"], [role="alertdialog"]') ?? findDialog(doc) ?? el);
    focus(findFocusable(dlg) ?? dlg);

    if (action === 'confirm') {
      const btn =
        findButton(dlg, /^(ok|confirm|save|yes|apply|submit|continue|done|accept)$/i) ??
        queryOne(dlg, '[type="submit"], [data-action="confirm"]');
      if (!btn) return fail('No confirm control in the dialog');
      clickEl(btn);
      steps.push('confirm dialog');
      return acted('modal', true, steps, { action });
    }

    // dismiss: Escape (focus-trap aware) then a cancel/close control.
    pressOn(dlg, 'Escape');
    steps.push('press Escape');
    const btn =
      findButton(dlg, /^(cancel|close|dismiss|no|back)$/i) ??
      queryOne(dlg, '[aria-label="Close" i], [data-action="cancel"], .close');
    if (btn) {
      clickEl(btn);
      steps.push('click dismiss control');
    }
    const closed =
      !doc.contains(dlg) ||
      dlg.getAttribute('aria-hidden') === 'true' ||
      (dlg instanceof HTMLElement && dlg.hidden !== false) ||
      (dlg.tagName === 'DIALOG' && !dlg.hasAttribute('open'));
    return acted('modal', closed, steps, { action });
  }

  async function combobox(
    input: Element,
    value: string,
    steps: string[],
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      setInputValue(input, value);
    } else {
      clickEl(input);
    }
    input.setAttribute('aria-expanded', 'true');
    steps.push(`type "${value}"`);
    if (aborted(signal)) return fail('aborted');

    const listbox = resolveListbox(doc, input);
    const found = await settle(() => optionEls(listbox).length > 0);
    if (!found) return fail('Combobox options never appeared');

    const options = optionEls(listbox);
    const match =
      options.find((o) => labelOf(o).toLowerCase() === value.toLowerCase()) ??
      options.find((o) => labelOf(o).toLowerCase().includes(value.toLowerCase()));
    if (!match) return fail(`No combobox option matches "${value}"`);

    // Actuate the real selection: click the app's option (fires its handler) and commit the chosen
    // label to the field. The app owns aria-selected/aria-activedescendant — the driver never fakes it.
    clickEl(match);
    steps.push(`choose option "${labelOf(match)}"`);
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      setInputValue(input, labelOf(match));
    }
    input.setAttribute('aria-expanded', 'false');
    return acted('combobox', true, steps, { value: labelOf(match) });
  }

  function slider(el: Element, value: number, steps: string[]): ToolResult {
    if (el instanceof HTMLInputElement && el.type === 'range') {
      const lo = num(el.min || null, 0);
      const hi = num(el.max || null, 100);
      const target = clamp(value, lo, hi);
      setInputValue(el, String(target));
      steps.push(`set range to ${target}`);
      return acted('slider', Number(el.value) === target, steps, { value: el.value });
    }

    const lo = num(el.getAttribute('aria-valuemin'), 0);
    const hi = num(el.getAttribute('aria-valuemax'), 100);
    const step = num(el.getAttribute('aria-valuestep'), 1) || 1;
    const target = clamp(value, lo, hi);
    focus(el);
    let cur = num(el.getAttribute('aria-valuenow'), lo);
    const cap = Math.min(MAX_SLIDER_PRESSES, Math.ceil(Math.abs(hi - lo) / step) + 2);
    let presses = 0;
    while (Math.abs(cur - target) >= step / 2 && presses < cap) {
      pressOn(el, cur < target ? 'ArrowRight' : 'ArrowLeft');
      const next = num(el.getAttribute('aria-valuenow'), cur);
      presses += 1;
      if (next === cur) break; // widget not honouring keys — stop rather than spin
      cur = next;
    }
    steps.push(`arrow-key to ${cur} (${presses} presses)`);
    return acted('slider', Math.abs(cur - target) < step, steps, { value: String(cur) });
  }

  async function datetime(
    trigger: Element,
    date: string,
    steps: string[],
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const [ys, ms, ds] = date.split('-');
    if (!ys || !ms || !ds) return fail(`Bad date "${date}" (want YYYY-MM-DD)`);
    const year = Number(ys);
    const month = Number(ms);
    const day = Number(ds);

    clickEl(trigger);
    steps.push('open calendar');
    if (aborted(signal)) return fail('aborted');
    await settle(() => findCalendar(doc) !== null);
    const cal = findCalendar(doc);
    if (!cal) return fail('Calendar did not open');

    for (let i = 0; i < MAX_NAV; i += 1) {
      if (aborted(signal)) return fail('aborted');
      const shown = readCalMonth(cal);
      if (!shown || (shown.year === year && shown.month === month)) break;
      const forward = shown.year < year || (shown.year === year && shown.month < month);
      const btn = navButton(cal, forward ? /next/i : /prev|previous/i);
      if (!btn) break;
      clickEl(btn);
      steps.push(forward ? 'next month' : 'previous month');
      await settle(() => true, 0); // yield for the grid to re-render
    }

    const cell = dayCells(cal).find(
      (c) => Number.parseInt(labelOf(c), 10) === day && isPickableDay(c),
    );
    if (!cell) return fail(`Day ${day} not found in the calendar`);
    clickEl(cell);
    steps.push(`pick day ${day}`);
    return acted('datetime', true, steps, { value: date });
  }

  async function carousel(
    root: Element,
    direction: 'next' | 'prev',
    times: number,
    steps: string[],
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const control = carouselControl(root, direction);
    if (!control) return fail(`No ${direction} control in the carousel`);
    for (let i = 0; i < times; i += 1) {
      if (aborted(signal)) return fail('aborted');
      clickEl(control);
      steps.push(`${direction} slide`);
      await settle(() => true, 0);
    }
    return acted('carousel', true, steps, { direction, times: String(times) });
  }

  function dragDrop(src: Element, toSelector: string, steps: string[]): ToolResult {
    const to = resolveTarget(doc, toSelector);
    if (!to) return notFound(toSelector);
    scrollIntoView(src);
    firePointer(src, 'pointerdown');
    fireMouse(src, 'mousedown');
    firePointer(src, 'pointermove');
    firePointer(to, 'pointermove');
    fireMouse(to, 'mousemove');
    firePointer(to, 'pointerup');
    fireMouse(to, 'mouseup');
    const dt = makeDataTransfer();
    fireDrag(src, 'dragstart', dt);
    fireDrag(to, 'dragenter', dt);
    fireDrag(to, 'dragover', dt);
    fireDrag(to, 'drop', dt);
    fireDrag(src, 'dragend', dt);
    steps.push('drag source -> target');
    return acted('dragDrop', true, steps, { to: toSelector });
  }

  async function run(recipe: WidgetRecipe, signal?: AbortSignal): Promise<ToolResult> {
    const el = resolveTarget(doc, recipe.selector);
    if (!el) return notFound(recipe.selector);
    const steps: string[] = [];
    switch (recipe.type) {
      case 'toggle':
        return toggle(el, recipe.on, steps);
      case 'tabs':
        return tabs(el, recipe.value, steps);
      case 'modal':
        return modal(el, recipe.action, steps, signal);
      case 'combobox':
        return combobox(el, recipe.value, steps, signal);
      case 'slider':
        return slider(el, recipe.value, steps);
      case 'datetime':
        return datetime(el, recipe.date, steps, signal);
      case 'carousel':
        return carousel(el, recipe.direction, recipe.times ?? 1, steps, signal);
      case 'dragDrop':
        return dragDrop(el, recipe.to, steps);
    }
  }

  return { run };
}

// The first focusable descendant of a container (focus-trap entry point) — else null.
function findFocusable(scope: ParentNode): Element | null {
  return queryOne(
    scope,
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
}
