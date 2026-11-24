import { describe, expect, it } from 'vitest';
import {
  ACT_OPS,
  ACT_PAGE_OPS,
  classifyTool,
  DRIVE_OPS,
  EDIT_OPS,
  isActOperation,
  overlayLabel,
  RECORD_OPS,
} from '@/shared/overlay-step';

describe('classifyTool', () => {
  it('classifies a mutating tool as "act" even without a selector', () => {
    expect(classifyTool('undo', {})).toEqual({ kind: 'act' });
  });

  it('classifies a mutating tool with a selector as "act", carrying the selector', () => {
    expect(classifyTool('setStyle', { selector: '.hero', props: {} })).toEqual({
      selector: '.hero',
      kind: 'act',
    });
  });

  it('classifies the real driving tool names pressKey/selectOption as "act"', () => {
    expect(classifyTool('pressKey', { key: 'Enter' })).toEqual({ kind: 'act' });
    expect(classifyTool('selectOption', { selector: '#country', value: 'US' })).toEqual({
      selector: '#country',
      kind: 'act',
    });
  });

  it('classifies a non-mutating tool with a selector as "read"', () => {
    expect(classifyTool('query', { selector: '.hero' })).toEqual({
      selector: '.hero',
      kind: 'read',
    });
  });

  it('classifies a non-mutating, selector-less tool as "info"', () => {
    expect(classifyTool('navigate', { url: 'https://example.com' })).toEqual({ kind: 'info' });
  });

  it('ignores a non-string selector field rather than throwing', () => {
    expect(classifyTool('query', { selector: 42 })).toEqual({ kind: 'info' });
  });

  it('handles non-object input', () => {
    expect(classifyTool('browse', undefined)).toEqual({ kind: 'info' });
    expect(classifyTool('browse', null)).toEqual({ kind: 'info' });
  });
});

describe('overlayLabel', () => {
  it('composes "tool → selector" when a selector is present', () => {
    expect(overlayLabel('setStyle', '.hero')).toBe('setStyle → .hero');
  });

  it('falls back to the bare tool name with no selector', () => {
    expect(overlayLabel('navigate', undefined)).toBe('navigate');
  });
});

// --- classify on the OPERATION, not the tool name ----------------------------------------------
//
// The old name-set classification was silently wrong for any dispatcher-shaped tool. `batch` was
// never in it, so a call carrying eight mutations rendered in the READ accent with no target
// highlight — the overlay quietly misreporting what the agent was doing to the user's page, with
// nothing throwing. The same would happen to every mutation under a consolidated tool surface.

describe('classifyTool: dispatcher-shaped inputs', () => {
  it('reads the operation out of a batch and calls it an ACT', () => {
    expect(
      classifyTool('batch', {
        ops: [
          { type: 'setStyle', selector: '.hero', props: { color: 'red' } },
          { type: 'addClass', selector: '.hero', name: 'x' },
        ],
      }),
    ).toEqual({ selector: '.hero', kind: 'act' });
  });

  it('classifies every grouped resource by its op — the dispatcher set, not a free-for-all', () => {
    // Only a KNOWN dispatcher's input names an operation (`DISPATCHER_TOOLS`): reading `op`/`type`
    // off arbitrary tool names is how an MCP tool's own field relabelled its call (below).
    for (const tool of ['edit', 'interact', 'session', 'inspect']) {
      expect(classifyTool(tool, { op: 'setStyle', selector: '.cta' }), tool).toEqual({
        selector: '.cta',
        kind: 'act',
      });
    }
  });

  it('never reads an operation off an unknown (MCP) tool input', () => {
    // `acme__task`'s input carries a `type` field of ITS vocabulary — it is not our operation, and
    // treating it as one labelled the call "bug" in the chip, overlay, log and rehydrated thread.
    expect(classifyTool('acme__task', { type: 'bug', title: 'broken checkout' })).toEqual({
      kind: 'info',
    });
    // …and an `op`-shaped field is equally out of bounds on a name we do not dispatch.
    expect(classifyTool('acme__manage', { op: 'setStyle', selector: '.cta' })).toEqual({
      selector: '.cta',
      kind: 'read', // it targets an element, but it is NOT one of our mutations
    });
  });

  it('still reads a grouped READ as a read', () => {
    expect(classifyTool('inspect', { op: 'getStyles', selector: '.cta' })).toEqual({
      selector: '.cta',
      kind: 'read',
    });
  });

  it('finds a selector nested under `params`', () => {
    expect(classifyTool('interact', { op: 'click', params: { selector: '#go' } })).toEqual({
      selector: '#go',
      kind: 'act',
    });
  });

  it('treats page ops that DRIVE the page as acts, and derived-layout reads as reads', () => {
    expect(classifyTool('pageOp', { op: 'freezeMotion', frozen: true })).toEqual({ kind: 'act' });
    expect(classifyTool('pageOp', { op: 'overflow' })).toEqual({ kind: 'info' });
    expect(classifyTool('pageOp', { op: 'box', selector: 'main' })).toEqual({
      selector: 'main',
      kind: 'read',
    });
  });

  it('classifies the REAL acting page ops — setField/pageCall/flush drive the page', () => {
    // These are `PageOp` discriminants (src/shared/page-ops.ts). The old list named
    // `setFieldValue`/`submitForm`/`focusField` — operations that do not exist — so every one of
    // these rendered in the read accent.
    expect(classifyTool('interact', { op: 'setField', selector: '#email', value: 'x' })).toEqual({
      selector: '#email',
      kind: 'act',
    });
    expect(classifyTool('interact', { op: 'pageCall', path: 'app.reload' })).toEqual({
      kind: 'act',
    });
    expect(classifyTool('pageOp', { op: 'flush' })).toEqual({ kind: 'act' });
    expect(classifyTool('pageOp', { op: 'media', action: 'pause' })).toEqual({ kind: 'act' });
  });

  it('covers the new structural mutations', () => {
    for (const op of ['wrapNode', 'unwrapNode', 'replaceNode', 'removeAttr', 'injectCss']) {
      expect(classifyTool('edit', { op, selector: '.x' }).kind, op).toBe('act');
    }
  });

  it('falls back to the tool name when the input carries no operation', () => {
    // Per-verb tools omit `type` (the tool name carries it), and MCP tools keep their own names
    // forever — both must keep working.
    expect(classifyTool('setStyle', { selector: '.hero', props: {} }).kind).toBe('act');
    expect(classifyTool('query', { selector: '.hero' }).kind).toBe('read');
    expect(classifyTool('acme__lookup', { q: 'tokens' }).kind).toBe('info');
  });

  it('never throws on a malformed input', () => {
    for (const input of [null, undefined, 42, 'str', { ops: 'nope' }, { ops: [] }, { op: 7 }]) {
      expect(() => classifyTool('edit', input)).not.toThrow();
    }
  });
});

describe('the exported classification vocabulary (turn-phase.ts derives from these)', () => {
  it('ACT_OPS is exactly the union of the three exported subsets — same membership as before', () => {
    expect([...ACT_OPS].sort()).toEqual([...EDIT_OPS, ...DRIVE_OPS, ...RECORD_OPS].sort());
  });

  it('the subsets are disjoint — every operation is classified exactly once', () => {
    const all = [...EDIT_OPS, ...DRIVE_OPS, ...RECORD_OPS, ...ACT_PAGE_OPS];
    expect(new Set(all).size).toBe(all.length);
  });

  it('isActOperation answers for every acting set and denies reads', () => {
    for (const op of [...EDIT_OPS, ...DRIVE_OPS, ...RECORD_OPS, ...ACT_PAGE_OPS]) {
      expect(isActOperation(op), op).toBe(true);
    }
    for (const op of ['query', 'getStyles', 'describe', 'box', 'overflow', 'screenshot']) {
      expect(isActOperation(op), op).toBe(false);
    }
  });
});

describe('overlayLabel: names the operation, not the wrapper', () => {
  it('prefers the op over the tool name when the input is available', () => {
    expect(overlayLabel('edit', '.hero', { op: 'setStyle', selector: '.hero' })).toBe(
      'setStyle → .hero',
    );
  });

  it('keeps the old two-argument behaviour', () => {
    expect(overlayLabel('navigate')).toBe('navigate');
    expect(overlayLabel('setStyle', '.hero')).toBe('setStyle → .hero');
  });

  it('keeps an MCP tool own name even when its input carries a `type` field', () => {
    expect(overlayLabel('acme__task', undefined, { type: 'bug', title: 'x' })).toBe('acme__task');
  });
});
