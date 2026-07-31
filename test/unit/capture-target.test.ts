import { describe, expect, it, vi } from 'vitest';
import {
  type CaptureTargetProbe,
  captureBlockedReason,
  inactiveCaptureError,
} from '@/agent/capture-target';

// #165 S1 unit: `chrome.tabs.captureVisibleTab` takes NO tabId — it grabs whatever tab is ACTIVE in
// the window. Every SW capture path resolved a `Target.tabId` and then captured by `windowId`
// alone, so a capture aimed at a background tab silently returned the user's own page: copy mode
// scroll-stitched reference tab R while every band came back as user tab U, and the model reported
// high fidelity on a "copy" of the page onto itself. Chrome-free — the tab probe is injected.

const probeFor = (tabs: Record<number, { active: boolean }>): CaptureTargetProbe =>
  vi.fn(async (tabId: number) => tabs[tabId]);

describe('captureBlockedReason', () => {
  it('allows a capture of the ACTIVE tab', async () => {
    const probe = probeFor({ 1: { active: true } });
    expect(await captureBlockedReason(probe, 1)).toBeNull();
  });

  it('refuses a capture of a background tab — the shipped silent-wrong-pixels bug', async () => {
    // Copy mode: reference tab 2 opened in the background, user tab 1 still active.
    const probe = probeFor({ 1: { active: true }, 2: { active: false } });
    expect(await captureBlockedReason(probe, 2)).toBe(inactiveCaptureError(2));
  });

  it('names the recovery the model already owns, so a copy turn is not dead-ended', async () => {
    const reason = inactiveCaptureError(7);
    expect(reason).toContain("tabs({ action: 'activate', tabId: 7 })");
    expect(reason).toContain('active tab');
  });

  it('refuses rather than capturing "whatever is active" when the tab is gone', async () => {
    const probe: CaptureTargetProbe = async () => undefined;
    expect(await captureBlockedReason(probe, 3)).toMatch(/no such tab/);
  });

  it('refuses when the tab lookup itself rejects, surfacing the reason', async () => {
    const probe: CaptureTargetProbe = async () => {
      throw new Error('No tab with id: 4.');
    };
    expect(await captureBlockedReason(probe, 4)).toMatch(/No tab with id: 4\./);
  });

  it('treats a tab with no `active` field as inactive — never optimistic', async () => {
    const probe: CaptureTargetProbe = async () => ({});
    expect(await captureBlockedReason(probe, 5)).toBe(inactiveCaptureError(5));
  });
});
