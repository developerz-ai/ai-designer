import { describe, expect, it } from 'vitest';
import {
  type ContentRoutedMessage,
  DESIGN_MUTATIONS,
  isDesignMutation,
  mutationBlockedReason,
} from '@/agent/tab-guard';
import { DomTool } from '@/shared/messages';

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

// Builds a minimal content-routed message of one type. The guard only reads `type`, `tabId` and
// (for `pageOp`) `op.op`, so the rest of each schema is irrelevant here.
function msg(type: string, tabId?: number): ContentRoutedMessage {
  return { type, tabId } as unknown as ContentRoutedMessage;
}
function pageOp(op: string, tabId?: number): ContentRoutedMessage {
  return { type: 'pageOp', op: { op }, tabId } as unknown as ContentRoutedMessage;
}

const ALL_MUTATORS = [
  'setStyle',
  'setText',
  'setAttr',
  'removeAttr',
  'addClass',
  'removeClass',
  'batch',
  'insertNode',
  'moveNode',
  'removeNode',
  'wrapNode',
  'unwrapNode',
  'replaceNode',
  'bulkStructural',
  'injectCss',
  'undo',
  'discardUndo',
];

describe('isDesignMutation', () => {
  it('covers every mutating DomTool member — including the structural four, removeAttr, bulkStructural and injectCss', () => {
    for (const type of ALL_MUTATORS) {
      expect(isDesignMutation(msg(type)), type).toBe(true);
    }
    expect([...DESIGN_MUTATIONS].sort()).toEqual([...ALL_MUTATORS].sort());
  });

  it('pins every DomTool member except the reads and the pageOp dispatcher', () => {
    // Derived from the live union, so a new DomTool member that is neither a declared read nor a
    // mutator fails here (the exhaustive Record in tab-guard.ts also fails the typecheck).
    const reads = new Set([
      'query',
      'getStyles',
      'screenshot',
      'a11ySnapshot',
      'diagnostics',
      'pageOp',
    ]);
    for (const option of DomTool.options) {
      const type = option.shape.type.value;
      expect(DESIGN_MUTATIONS.has(type), type).toBe(!reads.has(type));
    }
  });

  it('does not claim the reads', () => {
    for (const type of ['query', 'getStyles', 'a11ySnapshot', 'screenshot', 'diagnostics']) {
      expect(isDesignMutation(msg(type)), type).toBe(false);
    }
  });

  it('does not claim the page drivers — copy mode reaches content by driving a reference tab', () => {
    for (const type of ['click', 'type', 'hover', 'scrollTo', 'pressKey', 'waitFor', 'widgetAct']) {
      expect(isDesignMutation(msg(type)), type).toBe(false);
    }
  });

  it('decides pageOp per op: pageCall is pinned, reads and form/motion drivers are not', () => {
    expect(isDesignMutation(pageOp('pageCall'))).toBe(true);
    for (const op of [
      'box',
      'designSystem',
      'pageValue',
      'frameworkState',
      'freezeMotion',
      'setField',
    ]) {
      expect(isDesignMutation(pageOp(op)), op).toBe(false);
    }
  });
});

describe('mutationBlockedReason', () => {
  it('refuses a mutation aimed at another tab', () => {
    const reason = mutationBlockedReason(msg('setStyle', OTHER_TAB), TURN_TAB);
    expect(reason).not.toBeNull();
    expect(reason).toContain(`tab ${OTHER_TAB}`);
    expect(reason).toContain(`tab ${TURN_TAB}`);
    // Actionable, not a bare refusal — otherwise the model retries the same call with the same id.
    expect(reason).toContain('Re-send this without');
    expect(reason).toContain('read-only');
  });

  it('refuses EVERY mutation kind, not just setStyle', () => {
    for (const type of DESIGN_MUTATIONS) {
      expect(mutationBlockedReason(msg(type, OTHER_TAB), TURN_TAB), type).not.toBeNull();
    }
  });

  it('refuses injectCss on a reference tab — a whole stylesheet restyling the site being copied', () => {
    expect(mutationBlockedReason(msg('injectCss', OTHER_TAB), TURN_TAB)).not.toBeNull();
  });

  it('refuses pageOp(pageCall) on another tab and names the op', () => {
    const reason = mutationBlockedReason(pageOp('pageCall', OTHER_TAB), TURN_TAB);
    expect(reason).toContain('pageOp(pageCall)');
  });

  it('allows read-only pageOps on another tab', () => {
    expect(mutationBlockedReason(pageOp('designSystem', OTHER_TAB), TURN_TAB)).toBeNull();
  });

  it('allows a mutation with no tabId — the default IS the turn’s tab', () => {
    expect(mutationBlockedReason(msg('setStyle'), TURN_TAB)).toBeNull();
  });

  it('allows a mutation explicitly addressed at the turn’s own tab', () => {
    expect(mutationBlockedReason(msg('batch', TURN_TAB), TURN_TAB)).toBeNull();
  });

  it('allows READS on another tab — that is how copy mode studies a reference site', () => {
    for (const type of ['query', 'getStyles', 'a11ySnapshot', 'screenshot', 'extractIdentity']) {
      expect(mutationBlockedReason(msg(type, OTHER_TAB), TURN_TAB), type).toBeNull();
    }
  });

  it('allows DRIVERS on another tab — reaching content behind interaction is a read path', () => {
    for (const type of ['click', 'scrollTo', 'waitFor']) {
      expect(mutationBlockedReason(msg(type, OTHER_TAB), TURN_TAB), type).toBeNull();
    }
  });

  it('is per-TAB, never per-frame: frameId is not its business', () => {
    // Editing inside an iframe of the active page is ordinary work (embeds, payment widgets,
    // cross-origin sections). The guard reads only the tab id, so every frame of the turn's tab
    // stays writable — this test fails the moment someone widens it to frames.
    expect(mutationBlockedReason(msg('setStyle', TURN_TAB), TURN_TAB)).toBeNull();
    expect(mutationBlockedReason(msg('insertNode'), TURN_TAB)).toBeNull();
  });
});
