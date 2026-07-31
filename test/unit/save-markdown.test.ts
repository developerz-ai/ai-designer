import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveMarkdown } from '@/entrypoints/sidepanel/stores/changeset';

// The "download brief does nothing" bug.
//
// `saveMarkdown` created a blob URL, clicked a synthetic anchor, and revoked the URL in a
// `finally` — i.e. in the SAME TICK as the click. But `a.click()` only *schedules* the download;
// the browser fetches the blob asynchronously after the click returns. Revoking immediately pulled
// the URL out from under it, so the click fired, the store reported success, and no file ever
// arrived. Nothing threw, which is why it looked like the feature simply did not work.
//
// These assert the ordering contract, not the browser's download machinery: the URL must still be
// valid when the click returns, and must eventually be released so a long-lived panel does not
// retain report-sized blobs.

const OBJECT_URL = 'blob:chrome-extension://dz/report';

let createSpy: ReturnType<typeof vi.fn>;
let revokeSpy: ReturnType<typeof vi.fn>;
let clicked: { href: string; download: string; connected: boolean }[];

beforeEach(() => {
  vi.useFakeTimers();
  clicked = [];
  createSpy = vi.fn(() => OBJECT_URL);
  revokeSpy = vi.fn();
  vi.stubGlobal('URL', { ...URL, createObjectURL: createSpy, revokeObjectURL: revokeSpy });
  // Record the anchor's state AT CLICK TIME — the only moment that matters.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({
      href: this.href,
      download: this.download,
      connected: this.isConnected,
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('saveMarkdown', () => {
  it('does NOT revoke the blob URL before the click has been handled', () => {
    saveMarkdown('# Brief\n\nsome content', 'design-report.md');

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveLength(1);
    // The regression, stated directly: still live when the click returns.
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('clicks an anchor that is attached, addressed at the blob, and named', () => {
    saveMarkdown('# Brief', 'my-report.md');

    expect(clicked[0]?.href).toBe(OBJECT_URL);
    expect(clicked[0]?.download).toBe('my-report.md');
    expect(clicked[0]?.connected).toBe(true);
  });

  it('removes the anchor again — the panel must not accumulate them', () => {
    saveMarkdown('# Brief', 'a.md');
    saveMarkdown('# Brief', 'b.md');
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  });

  it('releases the URL eventually, so blobs are not retained for the panel’s lifetime', () => {
    saveMarkdown('# Brief', 'design-report.md');
    expect(revokeSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(revokeSpy).toHaveBeenCalledWith(OBJECT_URL);
  });
});
