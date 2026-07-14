// Persisted opt-in for the on-page agent-decision overlay (slice 09). Plain boolean in
// chrome.storage.local — no secret, so unlike src/agent/config-store.ts this is safe to read from
// BOTH the service worker (background.ts hydrates its in-memory `overlayEnabled` from it, and
// writes on `set-overlay-enabled`) and the content script (content.ts reads it once at
// document_idle to restore the overlay's on/off state across a page reload, without waiting on a
// round-trip to the SW). `storage` is a declared manifest permission for both worlds.
const OVERLAY_ENABLED_KEY = 'overlay:enabled';

/** Whether the user has opted into the on-page overlay. Defaults to `false` (opt-in). */
export async function readOverlayEnabled(): Promise<boolean> {
  const got = await chrome.storage.local.get(OVERLAY_ENABLED_KEY);
  return got[OVERLAY_ENABLED_KEY] === true;
}

export async function writeOverlayEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [OVERLAY_ENABLED_KEY]: enabled });
}
