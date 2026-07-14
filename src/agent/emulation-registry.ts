// Device-emulation teardown bookkeeping that survives service-worker eviction (slice 16 /
// SW-resilience). `setDevice`/`responsiveCapture` attach `chrome.debugger` (CDP) and/or resize the
// tab's window; that state MUST be undone or the user is left with a "being debugged" banner or a
// shrunk window. The turn's `.finally` normally restores it, but two gaps need a persisted,
// owner-scoped registry:
//   (a) an SW eviction mid-emulation kills the turn before its `.finally` runs — the attach/resize
//       is orphaned. Persisting to `chrome.storage.session` lets the next SW wake reconcile it.
//   (b) a superseded turn's `.finally` must not tear down emulation a newer, concurrent same-tab
//       turn just applied — teardown is scoped to the turn (`owner`) that applied it.
//
// SW-ONLY (touches `chrome.storage.session`); never import from content.ts. Chrome-free by
// construction otherwise — the raw debugger/window teardown is injected (`EmulationTeardown`), so
// the reconcile/ownership logic is unit-testable against an in-memory `chrome.storage.session` fake.

import { z } from 'zod';

const STORAGE_KEY = 'emulation:state';

const SavedWindow = z.object({
  windowId: z.number().int(),
  width: z.number().optional(),
  height: z.number().optional(),
});
export type SavedWindow = z.infer<typeof SavedWindow>;

const EmulationEntry = z.object({
  /** The turn (its id) that currently owns this tab's emulation — teardown is scoped to it. */
  owner: z.string(),
  cdpAttached: z.boolean(),
  savedWindow: SavedWindow.optional(),
});
type EmulationEntry = z.infer<typeof EmulationEntry>;

// Persisted map keyed by tabId (JSON object keys are strings; re-narrowed to number on hydrate).
const EmulationState = z.record(z.string(), EmulationEntry);

/** The raw debugger/window primitives the registry drives to undo emulation — injected so this
 *  module stays chrome-free. Both are best-effort (the tab/window may already be gone). */
export interface EmulationTeardown {
  detach(tabId: number): Promise<void>;
  restoreWindow(saved: SavedWindow): Promise<void>;
}

/**
 * The service worker's device-emulation teardown registry: an in-memory map of which tabs have the
 * debugger attached / a saved window size, mirrored to `chrome.storage.session`. Call `hydrate()`
 * then `reconcile()` once on SW wake to undo any emulation orphaned by an eviction; drive
 * `recordAttach`/`recordWindow`/`clearAttach`/`clearWindow` from the emulation driver so the
 * persisted state tracks reality; check `owns()` before a turn tears its own emulation down.
 */
export class EmulationRegistry {
  private entries = new Map<number, EmulationEntry>();

  /** Load the persisted registry into memory. Idempotent — call on each SW wake before reconcile. */
  async hydrate(): Promise<void> {
    const got = await chrome.storage.session.get(STORAGE_KEY);
    const parsed = EmulationState.safeParse(got[STORAGE_KEY]);
    this.entries.clear();
    if (parsed.success) {
      for (const [tabId, entry] of Object.entries(parsed.data))
        this.entries.set(Number(tabId), entry);
    }
  }

  /** Whether the debugger is recorded as attached to a tab (drives the driver's idempotent attach). */
  isAttached(tabId: number): boolean {
    return this.entries.get(tabId)?.cdpAttached ?? false;
  }

  /** The tab window's pre-emulation bounds, if a resize has been recorded (else undefined). */
  savedWindow(tabId: number): SavedWindow | undefined {
    return this.entries.get(tabId)?.savedWindow;
  }

  /** Whether `owner`'s turn is the one that currently owns this tab's emulation. */
  owns(tabId: number, owner: string): boolean {
    return this.entries.get(tabId)?.owner === owner;
  }

  /** Record (and take ownership of) a CDP attach on `tabId`. */
  async recordAttach(tabId: number, owner: string): Promise<void> {
    const entry = this.entries.get(tabId);
    this.entries.set(tabId, { owner, cdpAttached: true, savedWindow: entry?.savedWindow });
    await this.persist();
  }

  /** Record (and take ownership of) the tab window's saved pre-emulation bounds. */
  async recordWindow(tabId: number, owner: string, saved: SavedWindow): Promise<void> {
    const attached = this.entries.get(tabId)?.cdpAttached ?? false;
    this.entries.set(tabId, { owner, cdpAttached: attached, savedWindow: saved });
    await this.persist();
  }

  /** Forget a tab's CDP-attach record (its debugger was detached). */
  async clearAttach(tabId: number): Promise<void> {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    if (entry.savedWindow) this.entries.set(tabId, { ...entry, cdpAttached: false });
    else this.entries.delete(tabId);
    await this.persist();
  }

  /** Forget a tab's saved-window record (its window was restored). */
  async clearWindow(tabId: number): Promise<void> {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    if (entry.cdpAttached) this.entries.set(tabId, { owner: entry.owner, cdpAttached: true });
    else this.entries.delete(tabId);
    await this.persist();
  }

  /**
   * Wake reconcile: tear down every persisted emulation and clear the registry. Everything held
   * here on wake is orphaned — a woken SW does not resume the turn that applied it — so the debugger
   * is detached and any resized window restored so the user isn't left mid-emulation.
   */
  async reconcile(teardown: EmulationTeardown): Promise<void> {
    for (const [tabId, entry] of this.entries) {
      if (entry.cdpAttached) await teardown.detach(tabId).catch(() => {});
      if (entry.savedWindow) await teardown.restoreWindow(entry.savedWindow).catch(() => {});
    }
    this.entries.clear();
    await chrome.storage.session.remove(STORAGE_KEY);
  }

  private async persist(): Promise<void> {
    if (this.entries.size === 0) {
      await chrome.storage.session.remove(STORAGE_KEY);
      return;
    }
    const obj: Record<string, EmulationEntry> = {};
    for (const [tabId, entry] of this.entries) obj[String(tabId)] = entry;
    await chrome.storage.session.set({ [STORAGE_KEY]: obj });
  }
}
