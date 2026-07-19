// Persisted "first-run onboarding dismissed" flag (slice 24). Plain boolean in
// chrome.storage.local — no secret, so it lives alongside overlay-prefs.ts rather than the
// encrypted key store. Read + written ONLY by the service worker (background.ts's
// `get-onboarding-dismissed`/`set-onboarding-dismissed`): the side panel is a view and never
// touches storage directly (CLAUDE.md "MV3 three worlds"; stores/history.ts notes the same rule).
// `storage` is a declared manifest permission.
const ONBOARDING_DISMISSED_KEY = 'onboarding:dismissed';

/** Whether the user has dismissed (skipped or finished) the first-run guide. Defaults to
 *  `false` so the guide auto-shows on a fresh install and on every panel open until the user
 *  skips or finishes it (which sets this true); a step's "Fix" CTA only hides it for the session,
 *  so it returns next open. The panel also re-opens it on demand from Settings without flipping
 *  this. */
export async function readOnboardingDismissed(): Promise<boolean> {
  const got = await chrome.storage.local.get(ONBOARDING_DISMISSED_KEY);
  return got[ONBOARDING_DISMISSED_KEY] === true;
}

export async function writeOnboardingDismissed(dismissed: boolean): Promise<void> {
  await chrome.storage.local.set({ [ONBOARDING_DISMISSED_KEY]: dismissed });
}
