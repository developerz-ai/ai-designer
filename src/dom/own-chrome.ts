// The editor's own on-page UI: the picker and overlay shadow hosts (picker.ts / overlay.ts). Not
// `[data-dz-designer]` alone — that attribute is ALSO setStyle's per-element marker on PAGE
// elements (mutate.ts `MARKER_ATTR`), so only the two host values identify our chrome.
const OWN_HOST_SELECTOR = '[data-dz-designer="picker"], [data-dz-designer="overlay"]';

/** Whether `el` is (inside) one of the editor's own UI hosts rather than page content. */
export function isOwnChrome(el: Element): boolean {
  return el.closest(OWN_HOST_SELECTOR) !== null;
}
