import { afterEach, describe, expect, it } from 'vitest';
import type { PanelToSw } from '@/shared/messages';
import { OnboardingStateResult } from '@/shared/messages';
import { readOnboardingDismissed, writeOnboardingDismissed } from '@/shared/onboarding-prefs';

// Integration — the first-run "dismissed" seam: panel `set-onboarding-dismissed`/
// `get-onboarding-dismissed` -> SW persists via the REAL `@/shared/onboarding-prefs.ts`
// (chrome.storage.local). background.ts imports the WXT `#imports` virtual module and can't be
// imported under Vitest, so its two onboarding cases are reproduced 1:1 (writeOnboardingDismissed
// / readOnboardingDismissed + OnboardingStateResult). Assertions are on real round-tripped
// persistence, not on a mock alone. Simpler than the overlay seam: panel-only state, no in-memory
// SW mirror and no active-tab push.

function installChromeFakes(): { storage: Map<string, unknown> } {
  const storage = new Map<string, unknown>();
  const local = {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const names = keys == null ? [...storage.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (storage.has(name)) out[name] = storage.get(name);
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [name, value] of Object.entries(items)) storage.set(name, value);
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) storage.delete(k);
      return Promise.resolve();
    },
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { local } };
  return { storage };
}

// Mirrors background.ts's `case 'set-onboarding-dismissed'`.
async function handleSet(msg: PanelToSw & { type: 'set-onboarding-dismissed' }) {
  await writeOnboardingDismissed(msg.dismissed);
  return OnboardingStateResult.parse({ ok: true, dismissed: msg.dismissed });
}

// Mirrors background.ts's `case 'get-onboarding-dismissed'`.
async function handleGet() {
  return OnboardingStateResult.parse({ ok: true, dismissed: await readOnboardingDismissed() });
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
});

describe('integration: first-run onboarding dismissed-flag persistence', () => {
  it('defaults to not-dismissed on a fresh install, so the guide auto-shows once', async () => {
    installChromeFakes();
    expect(await handleGet()).toEqual({ ok: true, dismissed: false });
    expect(await readOnboardingDismissed()).toBe(false);
  });

  it('skipping/finishing persists dismissed=true through the REAL onboarding-prefs writer', async () => {
    const { storage } = installChromeFakes();

    const result = await handleSet({ type: 'set-onboarding-dismissed', dismissed: true });

    expect(result).toEqual({ ok: true, dismissed: true });
    expect(storage.get('onboarding:dismissed')).toBe(true);
    expect(await readOnboardingDismissed()).toBe(true);
    expect(await handleGet()).toEqual({ ok: true, dismissed: true });
  });

  it('the flag round-trips back to false (e.g. a future reset)', async () => {
    const { storage } = installChromeFakes();

    await handleSet({ type: 'set-onboarding-dismissed', dismissed: true });
    const off = await handleSet({ type: 'set-onboarding-dismissed', dismissed: false });

    expect(off).toEqual({ ok: true, dismissed: false });
    expect(storage.get('onboarding:dismissed')).toBe(false);
    expect(await readOnboardingDismissed()).toBe(false);
  });
});
