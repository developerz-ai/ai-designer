// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { withCaptureLock } from '@/agent/capture-lock';
import { type CaptureTargetProbe, captureBlockedReason } from '@/agent/capture-target';
import type { ScreenshotInput, ToolResult } from '@/shared/messages';

// Integration (#165 S1): the screenshot dispatch REFUSES a background tab instead of silently
// returning the active tab's pixels.
//
// `chrome.tabs.captureVisibleTab(windowId)` takes no tabId. Copy mode opens reference site R in a
// background tab (the system prompt tells the model to) while the user's tab U stays active, so
// `screenshot({ tabId: R, fullPage: true })` scroll-stitched R band by band while every grab
// returned U — the model "copied" the user's page onto itself and the wrong PNGs were embedded in
// the shipped brief, with no error anywhere.
//
// background.ts can't be imported under Vitest (WXT `#imports`), so its dispatch TOPOLOGY is
// reproduced here 1:1 against the real capture lock and the real guard — the same established
// pattern as capture-serialization.test.ts. The guard itself is imported, never copied, so the pin
// and the shipped policy cannot drift.

/** The two tabs of a copy-mode turn: U is the user's (active), R the reference (background). */
function fakeBrowser() {
  const tabs = new Map<number, { active: boolean; windowId: number; page: string }>([
    [1, { active: true, windowId: 100, page: 'users-page' }],
    [2, { active: false, windowId: 100, page: 'reference-page' }],
  ]);
  const probe: CaptureTargetProbe = async (tabId) => tabs.get(tabId);
  // Window-scoped, exactly like the real API: it returns whatever is ACTIVE, not what you asked for.
  const captureVisibleTab = vi.fn(async (windowId: number) => {
    const active = [...tabs.values()].find((t) => t.active && t.windowId === windowId);
    return `data:image/png;base64,${active?.page ?? 'nothing'}`;
  });
  const contentScreenshot = vi.fn(
    async (tabId: number): Promise<ToolResult> => ({
      type: 'tool-result',
      ok: true,
      // The element path crops in the SW from a window capture — same wrong-pixels exposure.
      data: await captureVisibleTab(tabs.get(tabId)?.windowId ?? 0),
    }),
  );
  const activate = (tabId: number): void => {
    for (const [id, tab] of tabs) tab.active = id === tabId;
  };
  return { tabs, probe, captureVisibleTab, contentScreenshot, activate };
}

type World = ReturnType<typeof fakeBrowser>;

/** Reproduces background.ts's `screenshotDispatchFor` with the #165 S1 guard in place. */
function screenshotDispatchFor(world: World, defaultTabId: number) {
  return async (input: ScreenshotInput): Promise<ToolResult> => {
    const tabId = input.tabId ?? defaultTabId;
    // The guard — before EITHER branch, and before any lock (a raw tab read, so the
    // capture-policy deadlock invariant holds).
    const blocked = await captureBlockedReason(world.probe, tabId);
    if (blocked) return { type: 'tool-result', ok: false, error: blocked };
    if (!input.fullPage || input.selector) return world.contentScreenshot(tabId);
    const windowId = world.tabs.get(tabId)?.windowId ?? 0;
    return withCaptureLock(tabId, async () => ({
      type: 'tool-result',
      ok: true,
      data: await world.captureVisibleTab(windowId),
    }));
  };
}

describe('integration: screenshot never captures a tab other than the one asked for', () => {
  it('refuses a full-page capture of a background reference tab', async () => {
    const world = fakeBrowser();
    const screenshot = screenshotDispatchFor(world, 1);

    const result = await screenshot({ type: 'screenshot', tabId: 2, fullPage: true });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("tabs({ action: 'activate', tabId: 2 })");
    // The decisive assertion: no grab happened at all, so no band of the user's page was ever
    // passed off as the reference site's.
    expect(world.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('refuses an element/viewport capture of a background tab too', async () => {
    const world = fakeBrowser();
    const screenshot = screenshotDispatchFor(world, 1);

    const result = await screenshot({ type: 'screenshot', tabId: 2, selector: '.hero' });

    expect(result.ok).toBe(false);
    expect(world.contentScreenshot).not.toHaveBeenCalled();
  });

  it('captures normally once the model activates the reference tab', async () => {
    const world = fakeBrowser();
    const screenshot = screenshotDispatchFor(world, 1);

    world.activate(2); // tabs({ action: 'activate', tabId: 2 }) — the recovery the error names
    const result = await screenshot({ type: 'screenshot', tabId: 2, fullPage: true });

    expect(result.ok).toBe(true);
    expect(result.data).toBe('data:image/png;base64,reference-page');
  });

  it("still captures the user's own tab with no extra step", async () => {
    const world = fakeBrowser();
    const screenshot = screenshotDispatchFor(world, 1);

    const result = await screenshot({ type: 'screenshot', fullPage: true });

    expect(result.ok).toBe(true);
    expect(result.data).toBe('data:image/png;base64,users-page');
  });

  it('refuses when the target tab was closed mid-turn rather than grabbing the active one', async () => {
    const world = fakeBrowser();
    const screenshot = screenshotDispatchFor(world, 1);

    world.tabs.delete(2);
    const result = await screenshot({ type: 'screenshot', tabId: 2, fullPage: true });

    expect(result.ok).toBe(false);
    expect(world.captureVisibleTab).not.toHaveBeenCalled();
  });
});
