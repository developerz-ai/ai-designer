// Per-edit before/after screenshot auto-capture (#148 item 1). The schema (`Edit.screenshots`)
// and the Diff-tab rendering existed since slice 05; nothing produced the data — only the model
// could attach shots by hand, and it never did. This module produces them at the CHEAP cadence
// the issue names: one before/after pair per recorded Edit (two capture-lock rides, ~200ms settle
// each), never per mutation.
//
// The recorder events reach the SW only AFTER a mutation ran, so a truthful "before" must be
// captured ahead of the mutation itself. The SW is the choke point every mutation dispatch passes
// through: the turn's content dispatch calls {@link EditShots.beforeMutation} ahead of the first
// UNRECORDED mutation (before slot empty AND recorder buffer empty — so the shot provably precedes
// every event the next drain folds), and `recordEdit`'s drain calls {@link EditShots.capturePair}
// for the matching "after". Interleaved multi-element work degrades honestly: once a drain
// consumed the slot while other groups are still buffered, later edits get an after-only pair
// rather than a fabricated before.
//
// BEST-EFFORT BY CONTRACT: every path swallows capture failures (inactive tab, no page access,
// abort) into `undefined` — a failed capture must never fail the mutation or the edit. Size-guarded
// ({@link guardShots}): screenshots are base64 data URLs headed for `chrome.storage.session`
// (BOTH changeset mirrors), so an oversized capture is SKIPPED, never stored — the record must
// not blow the storage quota that keeps undo/redo durable.
//
// Chrome-free by construction: capture + buffer probe are injected, so unit tests drive it with
// literals. Instantiated once in background.ts; the slot lifecycle mirrors the pending-mutations
// buffer's (cleared together on nav-clear / tab close / turn-end finalize) so a before shot never
// outlives the unrecorded mutations it precedes.

import type { Changeset } from '@/shared/changeset';

/** The `Edit.screenshots` payload — declared structurally so consumers stay schema-decoupled. */
export interface EditScreenshots {
  before?: string;
  after?: string;
}

// The content-routed message types that emit recorder MutationEvents (the MutationKind producers
// plus their multi-op carriers). `removeAttr` records as a `setAttr` event; `batch` and
// `bulkStructural` emit one event per op. Page-level ops (injectCss) and reads are absent — they
// never fold into an element Edit, so they must not arm a before shot.
export const RECORDED_MUTATION_TYPES: ReadonlySet<string> = new Set([
  'setStyle',
  'setText',
  'setAttr',
  'removeAttr',
  'addClass',
  'removeClass',
  'insertNode',
  'moveNode',
  'removeNode',
  'wrapNode',
  'unwrapNode',
  'replaceNode',
  'batch',
  'bulkStructural',
]);

/** Per-image ceiling (chars of data URL, ~0.5MB of PNG). A viewport grab on an ordinary display
 *  fits comfortably; a huge/high-DPR capture is skipped rather than stored. */
export const MAX_EDIT_SHOT_CHARS = 700_000;

/** Whole-changeset screenshot budget (chars across every edit's before+after). The record mirrors
 *  to `chrome.storage.session` TWICE (undo/redo persister + SessionStore resume snapshot), so this
 *  bounds the worst case at ~5MB of the ~10MB session quota — the changeset's durability (and the
 *  thread record sharing the area) must never lose to its own illustrations. */
export const MAX_CHANGESET_SHOT_CHARS = 2_500_000;

/** Chars of screenshot data already stored on a changeset — the `usedChars` input to
 *  {@link guardShots}, computed by the caller against the live store. */
export function screenshotChars(changeset: Changeset): number {
  let total = 0;
  for (const edit of changeset.edits) {
    total += edit.screenshots?.before?.length ?? 0;
    total += edit.screenshots?.after?.length ?? 0;
  }
  return total;
}

/** Apply the size guard to a captured pair: drop each side over the per-image ceiling, then drop
 *  the WHOLE pair when what remains would push the changeset past its screenshot budget (a lone
 *  "after" that fits is kept — partial beats nothing). Returns `undefined` when nothing survives,
 *  so the caller attaches no empty `screenshots` object. */
export function guardShots(shots: EditScreenshots, usedChars: number): EditScreenshots | undefined {
  const before =
    shots.before !== undefined && shots.before.length <= MAX_EDIT_SHOT_CHARS
      ? shots.before
      : undefined;
  const after =
    shots.after !== undefined && shots.after.length <= MAX_EDIT_SHOT_CHARS
      ? shots.after
      : undefined;
  const kept = (before?.length ?? 0) + (after?.length ?? 0);
  if (kept === 0 || usedChars + kept > MAX_CHANGESET_SHOT_CHARS) return undefined;
  return {
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

export interface EditShotsDeps {
  /** Capture the tab's viewport as a data URL. MUST resolve `undefined` on any failure (the
   *  background binding maps an error ToolResult to `undefined`); a rejection is treated the
   *  same, defensively. Rides the per-tab capture lock via the injected dispatch. */
  capture(tabId: number, signal?: AbortSignal): Promise<string | undefined>;
  /** Whether the tab's pending-mutations buffer holds nothing unrecorded — the arming condition
   *  that makes a before shot truthful (see the header). */
  bufferEmpty(tabId: number): boolean;
}

export interface EditShots {
  /** Arm the tab's BEFORE slot ahead of a recorder-emitting mutation dispatch. Captures only when
   *  no slot is held AND the recorder buffer is empty; otherwise awaits any in-flight capture so
   *  a same-step sibling mutation cannot land on the page before the shot is taken. Never throws,
   *  never fails the mutation. */
  beforeMutation(tabId: number, signal?: AbortSignal): Promise<void>;
  /** Consume the BEFORE slot and capture the AFTER — the `recordEdit`-drain pair. Size-guarded
   *  against `usedChars` (the changeset's existing screenshot chars); `undefined` when nothing
   *  usable survives. Never throws. */
  capturePair(
    tabId: number,
    usedChars: number,
    signal?: AbortSignal,
  ): Promise<EditScreenshots | undefined>;
  /** Drop the tab's BEFORE slot — call exactly where the pending buffer clears (nav-clear, tab
   *  close, turn-end finalize) so a shot of a dead document can never pair with a later edit. */
  clear(tabId: number): void;
}

export function createEditShots(deps: EditShotsDeps): EditShots {
  // tabId -> the in-flight/settled BEFORE capture. The promise (not the value) is stored so two
  // same-step mutations share one capture instead of racing two.
  const slots = new Map<number, Promise<string | undefined>>();

  return {
    async beforeMutation(tabId, signal) {
      const held = slots.get(tabId);
      if (held) {
        // A sibling same-step mutation armed the slot — wait it out so THIS mutation also
        // dispatches after the shot, then let the caller proceed.
        await held.catch(() => {});
        return;
      }
      if (!deps.bufferEmpty(tabId)) return; // unrecorded mutations already ran — a "before" would lie
      const shot = deps.capture(tabId, signal).catch(() => undefined);
      slots.set(tabId, shot);
      await shot;
    },

    async capturePair(tabId, usedChars, signal) {
      // Budget already spent ⇒ skip both capture rides, not just the attach.
      if (usedChars >= MAX_CHANGESET_SHOT_CHARS) {
        slots.delete(tabId);
        return undefined;
      }
      const held = slots.get(tabId);
      slots.delete(tabId);
      const before = held ? await held.catch(() => undefined) : undefined;
      const after = await deps.capture(tabId, signal).catch(() => undefined);
      if (before === undefined && after === undefined) return undefined;
      return guardShots({ before, after }, usedChars);
    },

    clear(tabId) {
      slots.delete(tabId);
    },
  };
}
