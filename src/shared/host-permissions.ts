// Optional host-permission handling for BYOK provider endpoints. A custom provider base
// URL points at a host the manifest doesn't statically grant (only `openrouter.ai` is in
// `host_permissions`), so an extension context needs a runtime host permission before it
// can fetch that origin without CORS trouble.
//
// `chrome.permissions.request` REQUIRES a live user gesture in the SAME call stack — it
// does not survive a hop across `chrome.runtime.sendMessage` (verified against a loaded
// extension: a click in the side panel that reaches the service worker via a message and
// then calls `request()` there fails immediately with "This function must be called
// during a user gesture", even though the click was real). So the request has to happen
// in whichever world actually receives the gesture. The side panel does it synchronously
// inside the Save button's click handler (`sidepanel/stores/settings.ts`); the service
// worker calls this again before persisting (`entrypoints/background.ts`) as a no-op
// defense-in-depth check — `contains()` is already true by then, so no second prompt.
//
// `chrome.permissions` is available in the SW and extension pages (side panel, popup,
// options) alike — never import this from content.ts (page world, no extension APIs).

export type HostAccess = { ok: boolean; reason?: HostAccessReason; error?: string };

/** Why an `ensureHostAccess` failure can be classified. `'denied'` = the user dismissed the
 *  host-permission prompt; the other failure branches (invalid URL, a thrown `request`) stay
 *  unclassified and carry a detailed `error` instead, so a caller can render a localized
 *  message for the common denial and the raw detail for the rare unexpected failure. */
export type HostAccessReason = 'denied';

/**
 * The `https://host/*` match pattern covering a base URL's origin, or null when the URL is
 * unparseable or not http(s). The port is intentionally dropped — Chrome match patterns are
 * origin-scoped and reject a `:port`, matching every port on the host instead (so a local
 * `http://localhost:1234/v1` endpoint is covered by `http://localhost/*`).
 */
export function originPattern(baseURL: string): string | null {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * Ensure the calling context can reach `baseURL`, requesting an optional host permission if
 * it isn't already held. Returns `{ ok: true }` when the origin is covered by a static
 * `host_permissions` entry (e.g. OpenRouter) or an existing runtime grant — in that case no
 * prompt is shown. For a not-yet-granted custom host it calls `chrome.permissions.request`;
 * a user denial surfaces as `{ ok: false, reason: 'denied', error }` so the caller can render
 * a localized message, while an invalid URL or a thrown `request` (e.g. no user gesture in
 * the SW) surfaces as `{ ok: false, error }` with the raw detail.
 */
export async function ensureHostAccess(baseURL: string): Promise<HostAccess> {
  const pattern = originPattern(baseURL);
  if (!pattern) return { ok: false, error: `Invalid provider URL: ${baseURL}` };
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return { ok: true };
    const granted = await chrome.permissions.request({ origins: [pattern] });
    return granted
      ? { ok: true }
      : { ok: false, reason: 'denied', error: `Host access denied for ${pattern}` };
  } catch (err) {
    return { ok: false, error: `Could not request host access for ${pattern}: ${String(err)}` };
  }
}
