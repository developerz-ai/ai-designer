// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createOverlay, OVERLAY_HOST_ID } from '@/dom/overlay';
import { OverlayAck, OverlayCmd } from '@/shared/messages';

// Integration: the overlay ACK, which is how the SW tells "the page took the toggle" apart from
// "this tab has no content script at all".
//
// The failure it exists for: the content script is manifest-injected at document_idle, so a tab
// that has been open since before the extension was installed or last reloaded never got one. The
// SW's `overlay-toggle` push was `.catch(() => {})`-swallowed, so the panel switch flipped to a
// confident green "On" over a page that would never paint an overlay — the single most common way
// this feature "doesn't work".
//
// background.ts / content.ts can't be imported under Vitest (they pull the WXT `#imports` virtual
// module — see overlay-forward.test.ts), so this composes the two halves the way those files wire
// them: content.ts's `OverlayCmd.safeParse` branch as the listener, and background.ts's
// `set-overlay-enabled` reachability read as the caller.

/** Verbatim reproduction of content.ts's OverlayCmd branch: handle, then ACK. A frame with no
 *  overlay (a child frame) stays silent, which is what makes the ack meaningful. */
function contentListener(overlay: ReturnType<typeof createOverlay> | null) {
  return (raw: unknown): unknown => {
    const parsed = OverlayCmd.safeParse(raw);
    if (!parsed.success || !overlay) return undefined;
    if (parsed.data.type === 'overlay-toggle') overlay.toggle(parsed.data.enabled);
    else {
      overlay.step({
        label: parsed.data.label,
        selector: parsed.data.selector,
        kind: parsed.data.kind,
      });
    }
    return { type: 'overlay-ack' } satisfies OverlayAck;
  };
}

/** Verbatim reproduction of background.ts's `set-overlay-enabled` reachability read. `send` stands
 *  in for `chrome.tabs.sendMessage(tabId, cmd, { frameId: 0 })` — which REJECTS when no listener
 *  exists in the target tab, and resolves with the listener's reply when one does. */
async function pushToggle(
  send: (cmd: OverlayCmd) => Promise<unknown>,
  enabled: boolean,
): Promise<boolean> {
  const cmd: OverlayCmd = { type: 'overlay-toggle', enabled };
  return send(cmd)
    .then((reply) => OverlayAck.safeParse(reply).success)
    .catch(() => false);
}

describe('integration: overlay toggle reachability', () => {
  it('reports reachedPage true and actually mounts when the page has a content script', async () => {
    const overlay = createOverlay(document);
    const listen = contentListener(overlay);

    const reached = await pushToggle(async (cmd) => listen(cmd), true);

    expect(reached).toBe(true);
    expect(overlay.isEnabled()).toBe(true);
    expect(document.getElementById(OVERLAY_HOST_ID)).not.toBeNull();
    overlay.destroy();
  });

  it('reports reachedPage FALSE for a tab with no content script — the "needs a reload" case', async () => {
    // What `chrome.tabs.sendMessage` does with no receiving end: rejects.
    const reached = await pushToggle(
      () => Promise.reject(new Error('Could not establish connection.')),
      true,
    );
    expect(reached).toBe(false);
  });

  it('reports reachedPage FALSE when a frame receives it but owns no overlay', async () => {
    // Child frames run the content script but `overlay` is null there (top-frame only), so they
    // deliberately do not ACK — an ack from one would falsely certify the top frame.
    const listen = contentListener(null);
    const reached = await pushToggle(async (cmd) => listen(cmd), true);
    expect(reached).toBe(false);
  });

  it('tears the host out of the page on toggle-off, and still acks', async () => {
    const overlay = createOverlay(document);
    const listen = contentListener(overlay);

    await pushToggle(async (cmd) => listen(cmd), true);
    const off = await pushToggle(async (cmd) => listen(cmd), false);

    expect(off).toBe(true);
    expect(overlay.isEnabled()).toBe(false);
    // Disabled means GONE, not hidden (src/dom/overlay.ts).
    expect(document.getElementById(OVERLAY_HOST_ID)).toBeNull();
  });
});
