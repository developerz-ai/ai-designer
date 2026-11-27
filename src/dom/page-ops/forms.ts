// Form state — read a whole form in one call, and write a field the way a framework notices.
//
// The single most cited reason to "just run some JS on the page" is that `el.value = 'x'` does not
// work: React installs its own value setter on the input's prototype and tracks the last value it
// wrote, so assigning through the instance leaves the framework convinced nothing changed. The fix
// is the native prototype setter plus the right events — real code, five lines, and once it is
// written the agent never needs raw JS for it again. `src/dom/interact.ts` already does this for
// typing text; this covers the rest of the field types and adds the bulk read.
//
// Pure DOM + injected document.

export interface FieldState {
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly checked: boolean | null;
  readonly disabled: boolean;
  readonly required: boolean;
  readonly valid: boolean;
  /** The browser's own validation message when the field is invalid, else `''`. */
  readonly validationMessage: string;
  readonly label: string | null;
}

const MAX_FIELDS = 100;
const MAX_VALUE = 400;

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function isField(el: Element): el is Field {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  );
}

/** The accessible label for a field: an explicit `<label for>`, a wrapping label, or the
 *  aria-label / placeholder fallbacks a real form usually carries. */
function labelFor(el: Field): string | null {
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim();
  const labelled = el.getAttribute('aria-labelledby');
  if (labelled) {
    const target = el.ownerDocument.getElementById(labelled);
    const text = target?.textContent?.trim();
    if (text) return text;
  }
  if (el.id) {
    const explicit = el.ownerDocument.querySelector(`label[for="${CSS_ESCAPE(el.id)}"]`);
    const text = explicit?.textContent?.trim();
    if (text) return text;
  }
  const wrapping = el.closest('label')?.textContent?.trim();
  if (wrapping) return wrapping;
  const placeholder = el.getAttribute('placeholder');
  return placeholder?.trim() || null;
}

// Minimal ident escape for the `label[for=…]` lookup. `CSS.escape` is absent under jsdom, and this
// only ever guards a lookup — a value it cannot express yields no match, never a broken selector.
function CSS_ESCAPE(v: string): string {
  return v.replace(/["\\]/g, '\\$&');
}

/** A field that holds (or held) a secret: a password input, or one whose `autocomplete` says it is a
 *  password — a show-password toggle flips `type` to `text` while the value is still the password. */
function isSecretField(el: Field): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  return (
    el.type === 'password' ||
    /(?:^|\s)(?:current-password|new-password)(?:\s|$)/i.test(el.autocomplete ?? '')
  );
}

/** The browser's validity verdict, read WITHOUT `checkValidity()`: that fires `invalid`, which runs
 *  page handlers mid-read — they can change the value, the type (a show-password toggle) or the
 *  message after the verdict was taken. `validity.valid` is the same verdict with no event. */
function validityOf(el: Field): boolean {
  return !el.willValidate || el.validity.valid;
}

/** Every field under `root`, with the state a form-debugging pass actually needs — including the
 *  browser's own validation verdict, which is invisible in a screenshot. */
export function readFormState(root: ParentNode): FieldState[] {
  const out: FieldState[] = [];
  for (const el of Array.from(root.querySelectorAll('input, textarea, select'))) {
    if (!isField(el) || out.length >= MAX_FIELDS) break;
    const checkable =
      el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
    const secret = isSecretField(el);
    const valid = validityOf(el);
    out.push({
      name: el.name || el.id || '',
      type: el instanceof HTMLSelectElement ? 'select' : el.type,
      // A password value is never read back: the field's presence and validity are the useful
      // facts, and the value would land in the model transcript…
      value: secret ? '' : String(el.value ?? '').slice(0, MAX_VALUE),
      checked: checkable ? el.checked : null,
      disabled: el.disabled,
      required: el.required,
      valid,
      // …and neither does its validation message, which a page validator can make quote it.
      validationMessage: secret ? '' : (el.validationMessage ?? ''),
      label: labelFor(el),
    });
  }
  return out;
}

// The native value setter, taken off the PROTOTYPE. React (and Vue's v-model, and Angular's
// ControlValueAccessor) install their own tracked setter on the instance; assigning through it
// updates the DOM while leaving the framework's shadow copy stale, so the next render puts the old
// value back. Going through the prototype descriptor writes the real value under the tracker, and
// the dispatched `input` event then makes the framework read it.
function nativeSet(el: Field, value: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) descriptor.set.call(el, value);
  else el.value = value;
}

export interface SetFieldResult {
  readonly value: string;
  readonly checked: boolean | null;
  readonly valid: boolean;
  readonly validationMessage: string;
}

/**
 * Set a field the way a user would — native setter, then the event sequence the framework listens
 * for. Returns the post-write state including validity, so the agent sees a rejected value
 * immediately instead of discovering it after a submit.
 *
 * Returns `null` for a target that is not a form field.
 */
export function setField(
  el: Element,
  input: { value?: string; checked?: boolean },
): SetFieldResult | null {
  if (!isField(el)) return null;
  // Sampled before any event runs, between the events and after them: a page handler can flip the
  // field's type either way (a show-password toggle) any number of times. Once detected, the flag
  // sticks for the rest of the call. (Validity is read without an event — see validityOf.)
  let secret = isSecretField(el);
  const doc = el.ownerDocument;
  const fire = (type: string): void => {
    el.dispatchEvent(new (doc.defaultView?.Event ?? Event)(type, { bubbles: true }));
  };

  if (input.checked !== undefined && el instanceof HTMLInputElement) {
    el.checked = input.checked;
    fire('input');
    fire('change');
  }
  if (input.value !== undefined) {
    nativeSet(el, input.value);
    fire('input');
    secret ||= isSecretField(el);
    fire('change');
  }
  secret ||= isSecretField(el);

  const checkable =
    el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
  const valid = validityOf(el);
  return {
    // Same rule as readFormState: a password value never reaches the model transcript…
    value: secret ? '' : String(el.value ?? '').slice(0, MAX_VALUE),
    checked: checkable ? el.checked : null,
    valid,
    // …and neither does a password field's validation MESSAGE: a page validator can quote the
    // rejected value (and even clear the field first), so only the validity verdict is reported.
    validationMessage: secret ? '' : (el.validationMessage ?? ''),
  };
}
