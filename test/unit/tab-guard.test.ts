import { describe, expect, it } from 'vitest';
import { DESIGN_MUTATIONS, isDesignMutation, mutationBlockedReason } from '@/agent/tab-guard';

// tab-guard unit: "the work happens on the page the user is looking at", enforced.
//
// The hole this closes: `background.ts` `contentDispatchFor` resolved EVERY content-routed message
// with `message.tabId ?? defaultTabId`, and `Target.tabId` is on every DomTool input — mutations
// included. Copy mode legitimately holds two tabs in one turn (the user's page + a reference site
// opened in the background to copy FROM), so a second tab id looked ordinary at that layer. A model
// that passed the reference tab's id to `setStyle`/`batch`/`insertNode` restyled the site it was
// supposed to be LEARNING from, while the user watched their own page not change — and the
// changeset, which ships as a diff against the user's page, recorded edits against another origin.

const TURN_TAB = 7;
const OTHER_TAB = 42;

describe('isDesignMutation', () => {
  it('covers every mutating DomTool member', () => {
    // Mirrors the mutating half of `DomTool` in src/shared/messages.ts. If a mutation is added
    // there and not here it would default to "allowed on any tab" — the exact silent failure this
    // module exists to prevent, so the list is pinned rather than derived.
    for (const type of [
      'setStyle',
      'setText',
      'setAttr',
      'addClass',
      'removeClass',
      'batch',
      'insertNode',
      'moveNode',
      'removeNode',
      'undo',
      'discardUndo',
    ]) {
      expect(isDesignMutation(type), type).toBe(true);
    }
    expect(DESIGN_MUTATIONS.size).toBe(11);
  });

  it('does not claim the reads', () => {
    for (const type of ['query', 'getStyles', 'a11ySnapshot', 'screenshot', 'diagnostics']) {
      expect(isDesignMutation(type), type).toBe(false);
    }
  });

  it('does not claim the page drivers — copy mode reaches content by driving a reference tab', () => {
    for (const type of ['click', 'type', 'hover', 'scrollTo', 'pressKey', 'waitFor', 'navigate']) {
      expect(isDesignMutation(type), type).toBe(false);
    }
  });
});

describe('mutationBlockedReason', () => {
  it('refuses a mutation aimed at another tab', () => {
    const reason = mutationBlockedReason('setStyle', OTHER_TAB, TURN_TAB);
    expect(reason).not.toBeNull();
    expect(reason).toContain(`tab ${OTHER_TAB}`);
    expect(reason).toContain(`tab ${TURN_TAB}`);
    // Actionable, not a bare refusal — otherwise the model retries the same call with the same id.
    expect(reason).toContain('Re-send this without');
    expect(reason).toContain('read-only');
  });

  it('refuses EVERY mutation kind, not just setStyle', () => {
    for (const type of DESIGN_MUTATIONS) {
      expect(mutationBlockedReason(type, OTHER_TAB, TURN_TAB), type).not.toBeNull();
    }
  });

  it('allows a mutation with no tabId — the default IS the turn’s tab', () => {
    expect(mutationBlockedReason('setStyle', undefined, TURN_TAB)).toBeNull();
  });

  it('allows a mutation explicitly addressed at the turn’s own tab', () => {
    expect(mutationBlockedReason('batch', TURN_TAB, TURN_TAB)).toBeNull();
  });

  it('allows READS on another tab — that is how copy mode studies a reference site', () => {
    for (const type of ['query', 'getStyles', 'a11ySnapshot', 'screenshot', 'extractIdentity']) {
      expect(mutationBlockedReason(type, OTHER_TAB, TURN_TAB), type).toBeNull();
    }
  });

  it('allows DRIVERS on another tab — reaching content behind interaction is a read path', () => {
    for (const type of ['click', 'scrollTo', 'waitFor', 'navigate']) {
      expect(mutationBlockedReason(type, OTHER_TAB, TURN_TAB), type).toBeNull();
    }
  });

  it('is per-TAB, never per-frame: frameId is not its business', () => {
    // Editing inside an iframe of the active page is ordinary work (embeds, payment widgets,
    // cross-origin sections). The guard reads only the tab id, so every frame of the turn's tab
    // stays writable — this test fails the moment someone widens it to frames.
    expect(mutationBlockedReason('setStyle', TURN_TAB, TURN_TAB)).toBeNull();
    expect(mutationBlockedReason('insertNode', undefined, TURN_TAB)).toBeNull();
  });
});
