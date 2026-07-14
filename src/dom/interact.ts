import { queryAll, queryOne } from '@/dom/read';
import { pickUnique } from '@/dom/selector';
import type { ControlTool, StableSelector, ToolResult, WaitCondition } from '@/shared/messages';

// Browser-control interaction engine — the content script's "drive the page like a user" half
// (slice 13). Where src/dom/execute.ts owns the reversible read/mutate primitives, this owns the
// irreversible ACTIONS the agent takes to reproduce a bug or reach hidden content: click, type,
// pressKey, hover, scrollTo, selectOption, a bounded waitFor, and native-dialog arming. Pure DOM +
// injected window/document (no chrome.*), so every branch runs under jsdom and the content
// entrypoint stays a thin wire (coverage-excluded). `readImages` is a read, not an action — it
// lives in src/dom/images.ts; this module handles the rest of the ControlTool union.
//
// Each action fires a realistic event sequence (pointer + mouse + keyboard, native value setters
// so React/Vue tracking sees the change) rather than a bare `.click()`, so framework listeners
// react as they would to a real user. Event/DOM constructors are the world globals (the injected
// `win` is used only for the event `view`, scroll, timing, and dialog arming). Selector resolution
// is best-effort: an unmatched selector is an error ToolResult, never a throw that kills the turn.

/** Every ControlTool this engine drives — the union minus `readImages` (a read; src/dom/images.ts). */
export type InteractTool = Exclude<ControlTool, { type: 'readImages' }>;

export interface InteractorDeps {
  /** The page document. Defaults to the live `document`; tests inject a jsdom one. */
  doc?: Document;
  /** The page window (event `view`, scroll, dialogs). Defaults to `doc`'s view, else `window`. */
  win?: Window;
}

export interface Interactor {
  run(tool: InteractTool): Promise<ToolResult>;
}

// waitFor bounds: a plain `timeMs` delay defaults to 5s; the schema hard-caps it at 30s so a stuck
// page can't hang the turn. `networkIdle`/settle resolves after QUIET_MS of no DOM mutations.
const DEFAULT_WAIT_MS = 5_000;
const QUIET_MS = 500;

function ok(data?: unknown, selector?: StableSelector): ToolResult {
  return {
    type: 'tool-result',
    ok: true,
    ...(data !== undefined ? { data } : {}),
    ...(selector ? { selector } : {}),
  };
}

function fail(error: string): ToolResult {
  return { type: 'tool-result', ok: false, error };
}

function notFound(selector: string): ToolResult {
  return fail(`No element matches selector: ${selector}`);
}

// --- event dispatch (jsdom-safe: fall back when a constructor is missing) --
// `view` is left off deliberately: some strict UIEvent impls reject a foreign Window, and
// listeners key off type/target/bubbles, not the event's view.

function fireMouse(el: Element, type: string, bubbles = true): boolean {
  return el.dispatchEvent(new MouseEvent(type, { bubbles, cancelable: true }));
}

function firePointer(el: Element, type: string, bubbles = true): void {
  if (typeof PointerEvent === 'function') {
    el.dispatchEvent(
      new PointerEvent(type, { bubbles, cancelable: true, pointerType: 'mouse', isPrimary: true }),
    );
  } else {
    fireMouse(el, type, bubbles);
  }
}

function fireKey(el: Element, type: string, key: string): boolean {
  return el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
}

function fireInput(el: Element): void {
  const event =
    typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true })
      : new Event('input', { bubbles: true });
  el.dispatchEvent(event);
}

function fireChange(el: Element): void {
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function scrollIntoView(el: Element): void {
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  }
}

// --- actions --------------------------------------------------------------

// Real user click order: pointer/mouse down → focus → pointer/mouse up → click. `.click()` gives
// the trusted click event + its default action (link nav, form submit, checkbox toggle); the
// dispatched down/up around it feed frameworks that bind those instead of `click`.
function click(el: Element): void {
  scrollIntoView(el);
  firePointer(el, 'pointerdown');
  fireMouse(el, 'mousedown');
  if (el instanceof HTMLElement) {
    try {
      el.focus();
    } catch {
      // focus() can throw on a detached/hidden element — the click still stands.
    }
  }
  firePointer(el, 'pointerup');
  fireMouse(el, 'mouseup');
  if (el instanceof HTMLElement) el.click();
  else fireMouse(el, 'click');
}

// Set `.value` through the prototype's native setter so React/Vue's value tracking observes the
// change (assigning `el.value` directly is swallowed by their instrumented instance setter).
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function isEditableHost(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const attr = el.getAttribute('contenteditable');
  return attr === '' || attr === 'true' || attr === 'plaintext-only';
}

function submitFrom(el: HTMLInputElement | HTMLTextAreaElement): void {
  // Enter submits — but honour a listener that preventDefaults the keydown, and never bypass
  // validation: prefer requestSubmit (fires the submit event) over the legacy submit().
  const proceed = fireKey(el, 'keydown', 'Enter');
  fireKey(el, 'keyup', 'Enter');
  const form = el.form;
  if (proceed && form) {
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
  }
}

function typeInto(
  el: Element,
  text: string,
  submit: boolean | undefined,
  doc: Document,
): ToolResult {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    setNativeValue(el, text);
    fireInput(el);
    fireChange(el);
    if (submit) submitFrom(el);
    return ok({ value: el.value }, pickUnique(el, doc));
  }
  if (isEditableHost(el)) {
    el.focus();
    el.textContent = text;
    fireInput(el);
    if (submit) {
      fireKey(el, 'keydown', 'Enter');
      fireKey(el, 'keyup', 'Enter');
    }
    return ok({ value: text }, pickUnique(el, doc));
  }
  return fail(`Element is not a text field: ${el.tagName.toLowerCase()}`);
}

function pressKey(key: string, doc: Document): ToolResult {
  const target = doc.activeElement ?? doc.body ?? doc.documentElement;
  if (!target) return fail('No element to receive the key press');
  fireKey(target, 'keydown', key);
  if ([...key].length === 1) fireKey(target, 'keypress', key);
  fireKey(target, 'keyup', key);
  return ok({ key });
}

function hover(el: Element): void {
  scrollIntoView(el);
  firePointer(el, 'pointerover');
  firePointer(el, 'pointerenter', false); // enter/over: enter does not bubble
  fireMouse(el, 'mouseover');
  fireMouse(el, 'mouseenter', false);
  fireMouse(el, 'mousemove');
}

function currentScroll(win: Window): { x: number; y: number } {
  return { x: win.scrollX, y: win.scrollY };
}

function scrollTo(
  selector: string | undefined,
  y: number | undefined,
  doc: Document,
  win: Window,
): ToolResult {
  if (selector) {
    const el = queryOne(doc, selector);
    if (!el) return notFound(selector);
    scrollIntoView(el);
    return ok(currentScroll(win), pickUnique(el, doc));
  }
  if (y !== undefined) {
    win.scrollTo({ top: y, left: win.scrollX, behavior: 'auto' });
    return ok(currentScroll(win));
  }
  return ok(currentScroll(win)); // neither → read current position (no-op)
}

function selectOption(el: Element, value: string, doc: Document): ToolResult {
  if (el instanceof HTMLSelectElement) {
    const options = Array.from(el.options);
    const match =
      options.find((o) => o.value === value) ??
      options.find((o) => (o.label || o.textContent?.trim()) === value);
    if (!match) return fail(`No <option> matches "${value}"`);
    el.value = match.value;
    fireInput(el);
    fireChange(el);
    return ok({ value: el.value }, pickUnique(el, doc));
  }
  // ARIA listbox / combobox — pick the option by data-value/value, else visible label.
  const options = queryAll(el, '[role="option"]');
  const match =
    options.find((o) => (o.getAttribute('data-value') ?? o.getAttribute('value')) === value) ??
    options.find(
      (o) => o.textContent?.trim() === value || o.getAttribute('aria-label')?.trim() === value,
    );
  if (!match) return fail(`No listbox option matches "${value}"`);
  for (const o of options) o.setAttribute('aria-selected', o === match ? 'true' : 'false');
  if (match instanceof HTMLElement) match.click();
  return ok({ value }, pickUnique(el, doc));
}

// --- waitFor (MutationObserver + bounded timeout) -------------------------

function now(win: Window): number {
  return win.performance?.now?.() ?? 0;
}

function describeCondition(cond: WaitCondition): string {
  if (cond.selector) return `selector ${cond.selector}`;
  if (cond.text) return `text "${cond.text}"`;
  if (cond.networkIdle) return 'network idle';
  return 'delay';
}

function conditionSatisfied(cond: WaitCondition, doc: Document): boolean {
  if (cond.selector && !queryOne(doc, cond.selector)) return false;
  if (cond.text && !(doc.body?.textContent ?? '').includes(cond.text)) return false;
  return Boolean(cond.selector || cond.text);
}

// Resolve as soon as the condition holds, or when the bound elapses. A selector/text condition
// that never appears resolves `met: false` (a real timeout the agent reads); a networkIdle/plain
// delay is a settle, so it resolves `met: true`. Every timer + the observer + any abort listener is
// torn down on settle — no leak, no double-resolve. `signal` lets a caller cancel a pending wait.
function waitFor(
  cond: WaitCondition,
  doc: Document,
  win: Window,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const timeout = cond.timeMs ?? DEFAULT_WAIT_MS;
  const wantsElement = Boolean(cond.selector || cond.text);
  const started = now(win);
  const settle = (met: boolean): ToolResult =>
    ok({
      met,
      condition: describeCondition(cond),
      timedOut: !met,
      elapsedMs: Math.round(now(win) - started),
    });

  if (wantsElement && conditionSatisfied(cond, doc)) return Promise.resolve(settle(true));
  if (signal?.aborted) return Promise.resolve(settle(false));

  return new Promise<ToolResult>((resolve) => {
    let done = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => onMutation());
    const timer = setTimeout(() => finish(!wantsElement), timeout);

    const finish = (met: boolean): void => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      if (quiet) clearTimeout(quiet);
      signal?.removeEventListener('abort', onAbort);
      resolve(settle(met));
    };
    const onAbort = (): void => finish(false);
    const armQuiet = (): void => {
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => finish(true), QUIET_MS);
    };
    const onMutation = (): void => {
      if (wantsElement) {
        if (conditionSatisfied(cond, doc)) finish(true);
      } else if (cond.networkIdle) {
        armQuiet(); // reset the idle window on every mutation
      }
    };

    observer.observe(doc.documentElement ?? doc, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    if (!wantsElement && cond.networkIdle) armQuiet();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// --- native dialog arming (content world) ---------------------------------

// Arm an auto-answer for native dialogs (`alert`/`confirm`/`prompt`) the agent's own actions
// trigger, so a click/type that raises one doesn't stall the turn. Content scripts run in an
// ISOLATED world, so this governs dialogs raised in the content world; page-world native dialogs
// (and `beforeunload`) are answered by the service worker over the debugger protocol (a later
// slice-13 SW task). Kept honest + typed here; the SW mirrors the same policy.
function handleDialog(accept: boolean, promptText: string | undefined, win: Window): ToolResult {
  win.alert = (): void => {};
  win.confirm = (): boolean => accept;
  win.prompt = (): string | null => (accept ? (promptText ?? '') : null);
  return ok({ accept, ...(promptText !== undefined ? { promptText } : {}) });
}

export function createInteractor(deps: InteractorDeps = {}): Interactor {
  const doc = deps.doc ?? document;
  const win = deps.win ?? doc.defaultView ?? window;

  const withElement = (selector: string, apply: (el: Element) => ToolResult): ToolResult => {
    const el = queryOne(doc, selector);
    return el ? apply(el) : notFound(selector);
  };

  async function run(tool: InteractTool): Promise<ToolResult> {
    switch (tool.type) {
      case 'click':
        return withElement(tool.selector, (el) => {
          click(el);
          return ok(undefined, pickUnique(el, doc));
        });
      case 'type':
        return withElement(tool.selector, (el) => typeInto(el, tool.text, tool.submit, doc));
      case 'pressKey':
        return pressKey(tool.key, doc);
      case 'hover':
        return withElement(tool.selector, (el) => {
          hover(el);
          return ok(undefined, pickUnique(el, doc));
        });
      case 'scrollTo':
        return scrollTo(tool.selector, tool.y, doc, win);
      case 'selectOption':
        return withElement(tool.selector, (el) => selectOption(el, tool.value, doc));
      case 'waitFor':
        return waitFor(tool, doc, win);
      case 'handleDialog':
        return handleDialog(tool.accept, tool.promptText, win);
    }
  }

  return { run };
}
