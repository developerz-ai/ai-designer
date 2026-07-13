// Optional host-permission handling for BYOK provider endpoints. A custom provider base
// URL points at a host the manifest doesn't statically grant (only `openrouter.ai` is in
// `host_permissions`), so the service worker must hold a runtime host permission before it
// can fetch that origin (cross-origin fetch is otherwise CORS-blocked). SW-ONLY — the
// chrome.permissions calls run in the service worker; never import this from content.ts.
//
// `originPattern` is pure + unit-tested; `ensureHostAccess` wraps it around
// chrome.permissions. Least privilege: the grant is requested per-origin at save, drawing
// from `optional_host_permissions` (wxt.config.ts), not baked into the manifest.

export type HostAccess = { ok: boolean; error?: string };

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
 * Ensure the SW can reach `baseURL`, requesting an optional host permission if it isn't
 * already held. Returns `{ ok: true }` when the origin is covered by a static
 * `host_permissions` entry (e.g. OpenRouter) or an existing runtime grant — in that case no
 * prompt is shown. For a not-yet-granted custom host it calls `chrome.permissions.request`;
 * a user denial surfaces as `{ ok: false, error }` so the caller can avoid persisting a
 * config it can never fetch.
 *
 * `chrome.permissions.request` requires a user gesture, which does not cross the panel->SW
 * message boundary. The panel is expected to grant on the Save click (leaving `contains`
 * true here); if it didn't, `request` rejects and we surface that rather than throwing.
 */
export async function ensureHostAccess(baseURL: string): Promise<HostAccess> {
  const pattern = originPattern(baseURL);
  if (!pattern) return { ok: false, error: `Invalid provider URL: ${baseURL}` };
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return { ok: true };
    const granted = await chrome.permissions.request({ origins: [pattern] });
    return granted ? { ok: true } : { ok: false, error: `Host access denied for ${pattern}` };
  } catch (err) {
    return { ok: false, error: `Could not request host access for ${pattern}: ${String(err)}` };
  }
}
