import { describe, expect, it } from 'vitest';
import { createPendingMutations, foldMutationEvents } from '@/changeset/pending-mutations';
import type { Edit, StableSelector } from '@/shared/changeset';
import type { MutationEvent, MutationKind } from '@/shared/messages';

// pending-mutations unit: the SW-side #9 recorder buffer + the recordEdit fold (the fold lives in
// src/changeset/fold-mutations.ts, re-exported here — this suite exercises both through the public
// import path). Buffer: append / exact-match drain / single-group implicit drain / the gated
// unmatched-explicit-selector rescue (plausible paraphrase drains, implausible miss leaves the
// buffer) / drain's dropped-snapshot-and-reset / per-tab cap with droppedCount / remove
// (recorder-revert: LIFO ts+selector+kind) / peekGroups / clear. Fold: first-before/last-after per
// family, class WINDOW SET-DIFF (first class-relevant before-classAttr vs last after-classAttr —
// immune to setAttr('class') interleaves and page churn), setAttr('class') feeds classes and is
// SKIPPED in attrs, selector healed to the first event's (ground truth), structural first-folds +
// additional ops SPILL OVER into their own auto-recorded edits (carrying the model edit's
// breakpoint), frameworkHints union, ground-truth-wins per family (incl. merged-empty replacing
// the model's stale delta), and back-compat with pre-#9 events that carry none of the optional
// mechanical fields.

const TAB = 7;

const sel = (value: string): StableSelector => ({ value, strategy: 'css-path', fragile: false });

let clock = 0;
const ev = (kind: MutationKind, selectorValue: string, extra: Partial<MutationEvent> = {}) => {
  clock += 1;
  const event: MutationEvent = {
    kind,
    selector: sel(selectorValue),
    before: '',
    after: '',
    ts: clock,
    ...extra,
  };
  return event;
};

const anEdit = (overrides: Partial<Edit> = {}): Edit => ({
  intent: 'make it pop',
  selector: sel('#cta'),
  changes: [{ prop: 'color', before: '#000', after: '#00f' }],
  attrs: [],
  classes: [],
  frameworkHints: [],
  ...overrides,
});

describe('createPendingMutations: buffer semantics', () => {
  it('drains only the exact selector-value match, in arrival order, and keeps the rest', () => {
    const pending = createPendingMutations();
    const a1 = ev('setStyle', '#a');
    const b1 = ev('setStyle', '#b');
    const c1 = ev('setStyle', '#c');
    const a2 = ev('addClass', '#a');
    pending.append(TAB, a1);
    pending.append(TAB, b1);
    pending.append(TAB, c1);
    pending.append(TAB, a2);

    expect(pending.drain(TAB, '#a')).toEqual({ events: [a1, a2], dropped: 0, rescued: false });
    // Consumed — and ambiguous: TWO groups remain, so the unmatched re-drain cannot fall back
    // to the single-group rescue below and drains nothing.
    expect(pending.drain(TAB, '#a')).toEqual({ events: [], dropped: 0, rescued: false });
    expect(pending.drain(TAB, '#b')).toEqual({ events: [b1], dropped: 0, rescued: false });
    expect(pending.drain(TAB, '#c')).toEqual({ events: [c1], dropped: 0, rescued: false });
    expect(pending.peekGroups(TAB)).toEqual([]);
  });

  it('drain with no selector value drains all when exactly one distinct value is buffered', () => {
    const pending = createPendingMutations();
    const a1 = ev('setStyle', '#a');
    const a2 = ev('setText', '#a');
    pending.append(TAB, a1);
    pending.append(TAB, a2);

    expect(pending.drain(TAB)).toEqual({ events: [a1, a2], dropped: 0, rescued: false });
    expect(pending.peekGroups(TAB)).toEqual([]);
  });

  it('drain with no selector value drains nothing when several distinct values are buffered', () => {
    const pending = createPendingMutations();
    pending.append(TAB, ev('setStyle', '#a'));
    pending.append(TAB, ev('setStyle', '#b'));

    expect(pending.drain(TAB)).toEqual({ events: [], dropped: 0, rescued: false });
    expect(pending.peekGroups(TAB)).toHaveLength(2); // buffer untouched
  });

  it('drains nothing for an unknown tab', () => {
    const pending = createPendingMutations();
    pending.append(TAB, ev('setStyle', '#a'));

    expect(pending.drain(999)).toEqual({ events: [], dropped: 0, rescued: false });
    expect(pending.peekGroups(TAB)).toHaveLength(1); // untouched
  });

  // #9 round-2 review fix: the unmatched-explicit-selector rescue is GATED — the one buffered
  // group drains only when its value is plausibly the same target (one value contains the
  // other, case-sensitive). An implausible miss leaves the group for the turn-end
  // auto-finalize, which records it under its real selector.
  it('an unmatched explicit selector drains the group when it plausibly paraphrases the one buffered value', () => {
    const pending = createPendingMutations();
    const a1 = ev('setStyle', '#cta');
    const a2 = ev('setStyle', '#cta');
    pending.append(TAB, a1);
    pending.append(TAB, a2);

    // The model paraphrased its selector (`.hero #cta` vs the buffered `#cta`) — plausible.
    expect(pending.drain(TAB, '.hero #cta')).toEqual({
      events: [a1, a2],
      dropped: 0,
      rescued: true,
    });
    expect(pending.peekGroups(TAB)).toEqual([]); // consumed, not stranded
  });

  it('the rescue also fires when the buffered value contains the model value', () => {
    const pending = createPendingMutations();
    const a1 = ev('setStyle', '.hero .cta');
    pending.append(TAB, a1);

    expect(pending.drain(TAB, '.cta')).toEqual({ events: [a1], dropped: 0, rescued: true });
  });

  it('an unmatched explicit selector does NOT drain an unrelated single group (no shared substring)', () => {
    const pending = createPendingMutations();
    pending.append(TAB, ev('setStyle', '#sidebar'));
    pending.append(TAB, ev('addClass', '#sidebar'));

    // recordEdit for '#cta' has NO events; the one buffered group is an unrelated element.
    // Draining it here would fold the sidebar's ground truth into the CTA's Edit.
    expect(pending.drain(TAB, '#cta')).toEqual({ events: [], dropped: 0, rescued: false });
    expect(pending.peekGroups(TAB)).toHaveLength(1); // left for the auto-finalize
  });

  it('an unmatched explicit selector drains nothing when several distinct values are buffered (ambiguous)', () => {
    const pending = createPendingMutations();
    pending.append(TAB, ev('setStyle', '#a'));
    pending.append(TAB, ev('setStyle', '#b'));

    expect(pending.drain(TAB, '#nope')).toEqual({ events: [], dropped: 0, rescued: false });
    expect(pending.peekGroups(TAB)).toHaveLength(2); // untouched — the caller must name a real one
  });

  it('caps entries per tab, dropping the oldest', () => {
    const pending = createPendingMutations({ cap: 3 });
    const events = [
      ev('setStyle', '#a'),
      ev('setStyle', '#a'),
      ev('setStyle', '#a'),
      ev('setStyle', '#a'),
    ];
    for (const e of events) pending.append(TAB, e);

    expect(pending.drain(TAB)).toEqual({
      events: events.slice(1),
      dropped: 1,
      rescued: false,
    });
  });

  it('clear wipes the tab buffer', () => {
    const pending = createPendingMutations();
    pending.append(TAB, ev('setStyle', '#a'));

    pending.clear(TAB);

    expect(pending.peekGroups(TAB)).toEqual([]);
    expect(pending.drain(TAB, '#a')).toEqual({ events: [], dropped: 0, rescued: false });
  });

  it('peekGroups groups by selector value in first-seen order without consuming', () => {
    const pending = createPendingMutations();
    const a1 = ev('setStyle', '#a');
    const b1 = ev('setStyle', '#b');
    const a2 = ev('addClass', '#a');
    pending.append(TAB, a1);
    pending.append(TAB, b1);
    pending.append(TAB, a2);

    const groups = pending.peekGroups(TAB);
    expect(groups.map((g) => g.selector.value)).toEqual(['#a', '#b']);
    expect(groups[0]?.events).toEqual([a1, a2]);
    expect(groups[0]?.selector).toEqual(a1.selector);
    expect(groups[1]?.events).toEqual([b1]);
    // Non-consuming: a second peek sees the same groups.
    expect(pending.peekGroups(TAB)).toHaveLength(2);
  });
});

describe('createPendingMutations: droppedCount (cap-drop marker)', () => {
  it('counts events dropped at the cap per tab', () => {
    const pending = createPendingMutations({ cap: 2 });
    expect(pending.droppedCount(TAB)).toBe(0);

    pending.append(TAB, ev('setStyle', '#a'));
    pending.append(TAB, ev('setStyle', '#a'));
    expect(pending.droppedCount(TAB)).toBe(0); // at the cap, not past it

    pending.append(TAB, ev('setStyle', '#a')); // one over → one dropped
    expect(pending.droppedCount(TAB)).toBe(1);

    pending.append(TAB, ev('setStyle', '#a'));
    pending.append(TAB, ev('setStyle', '#a'));
    expect(pending.droppedCount(TAB)).toBe(3); // cumulative
  });

  it('tracks the count per tab independently', () => {
    const pending = createPendingMutations({ cap: 1 });
    pending.append(TAB, ev('setStyle', '#a'));
    pending.append(TAB, ev('setStyle', '#a')); // TAB drops one
    pending.append(99, ev('setStyle', '#b'));

    expect(pending.droppedCount(TAB)).toBe(1);
    expect(pending.droppedCount(99)).toBe(0);
  });

  it('clear resets the drop counter', () => {
    const pending = createPendingMutations({ cap: 1 });
    pending.append(TAB, ev('setStyle', '#a'));
    pending.append(TAB, ev('setStyle', '#a'));
    expect(pending.droppedCount(TAB)).toBe(1);

    pending.clear(TAB);

    expect(pending.droppedCount(TAB)).toBe(0);
  });

  it('drain snapshots the drop count and resets it to 0 (even on a no-match drain)', () => {
    const pending = createPendingMutations({ cap: 1 });
    pending.append(TAB, ev('setStyle', '#a'));
    pending.append(TAB, ev('setStyle', '#a')); // one dropped
    expect(pending.droppedCount(TAB)).toBe(1);

    // The drain that consumes the group also consumes its loss marker.
    const result = pending.drain(TAB, '#a');
    expect(result.dropped).toBe(1);
    expect(pending.droppedCount(TAB)).toBe(0); // reset

    // A later drain sees a clean counter — the loss is reported exactly once.
    expect(pending.drain(TAB).dropped).toBe(0);
  });
});

describe('createPendingMutations: remove (recorder-revert)', () => {
  it('removes the buffered event matching by ts and reports true', () => {
    const pending = createPendingMutations();
    const a1 = ev('setStyle', '#a');
    const a2 = ev('addClass', '#a');
    pending.append(TAB, a1);
    pending.append(TAB, a2);

    expect(pending.remove(TAB, a1)).toBe(true);
    expect(pending.peekGroups(TAB)[0]?.events).toEqual([a2]);
  });

  // #9 round-2 review fix: the ts match is LIFO and requires selector.value + kind too —
  // Date.now() ms resolution makes same-ts collisions real in a fast tool burst.
  it('a same-ts burst removes the NEWEST event matching ts + selector + kind; unrelated same-ts events survive', () => {
    const pending = createPendingMutations();
    const older = ev('setStyle', '#a', { ts: 100 });
    const newer = ev('setStyle', '#a', { ts: 100 }); // collided ts (ms clock)
    const otherKind = ev('addClass', '#a', { ts: 100 }); // same ts, different kind
    pending.append(TAB, older);
    pending.append(TAB, newer);
    pending.append(TAB, otherKind);

    // The revert carries ts=100 + setStyle + #a: the newest FULL match (newer) dies; the
    // same-ts addClass and the older setStyle survive.
    expect(pending.remove(TAB, ev('setStyle', '#a', { ts: 100 }))).toBe(true);
    expect(pending.peekGroups(TAB)[0]?.events).toEqual([older, otherKind]);
  });

  it('falls back to the LAST event with the same selector value + kind when ts matches nothing', () => {
    const pending = createPendingMutations();
    const first = ev('setStyle', '#a');
    const second = ev('setStyle', '#a');
    pending.append(TAB, first);
    pending.append(TAB, second);
    // A re-generated clock collided the revert's ts — the revert unwinds LIFO, so the NEWEST
    // matching buffered event is the one that died.
    const collided: MutationEvent = { ...second, ts: 999_999 };

    expect(pending.remove(TAB, collided)).toBe(true);
    expect(pending.peekGroups(TAB)[0]?.events).toEqual([first]); // second removed, first survives
  });

  it('prefers the exact ts match over the selector+kind fallback', () => {
    const pending = createPendingMutations();
    const first = ev('setStyle', '#a');
    const second = ev('setStyle', '#a');
    pending.append(TAB, first);
    pending.append(TAB, second);

    // ts matches the FIRST — remove exactly that one, not the LIFO one.
    expect(pending.remove(TAB, first)).toBe(true);
    expect(pending.peekGroups(TAB)[0]?.events).toEqual([second]);
  });

  it('reports false when nothing matches (and for an unknown tab)', () => {
    const pending = createPendingMutations();
    pending.append(TAB, ev('setStyle', '#a'));

    expect(pending.remove(TAB, ev('addClass', '#a'))).toBe(false); // kind differs
    expect(pending.remove(TAB, ev('setStyle', '#b'))).toBe(false); // selector differs
    expect(pending.remove(999, ev('setStyle', '#a'))).toBe(false); // unknown tab
    expect(pending.peekGroups(TAB)).toHaveLength(1); // untouched
  });

  it('drops the tab entry when the removal empties the buffer', () => {
    const pending = createPendingMutations();
    const only = ev('setStyle', '#a');
    pending.append(TAB, only);

    expect(pending.remove(TAB, only)).toBe(true);
    expect(pending.peekGroups(TAB)).toEqual([]);
  });
});

describe('foldMutationEvents: per-family merges', () => {
  it('merges styleChanges first-before / last-after per prop and drops no-op pairs', () => {
    const edit = anEdit({ changes: [] });
    const events = [
      ev('setStyle', '#cta', {
        styleChanges: [
          { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(0, 0, 255)' },
          { prop: 'margin', before: null, after: '8px' },
        ],
      }),
      ev('setStyle', '#cta', {
        styleChanges: [
          { prop: 'color', before: 'rgb(0, 0, 255)', after: 'rgb(255, 0, 0)' },
          // Applied then reverted across the group → no net change → dropped.
          { prop: 'padding', before: '4px', after: '4px' },
        ],
      }),
    ];

    const { folded, spillover } = foldMutationEvents(edit, events);

    expect(folded.changes).toEqual([
      { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
      { prop: 'margin', before: null, after: '8px' },
    ]);
    expect(spillover).toEqual([]);
  });

  it('merges attrChanges first-before / last-after per name and drops no-op pairs', () => {
    const edit = anEdit();
    const events = [
      ev('setAttr', '#cta', { attrChange: { name: 'href', before: null, after: '/a' } }),
      ev('setAttr', '#cta', { attrChange: { name: 'href', before: '/a', after: '/b' } }),
      ev('setAttr', '#cta', { attrChange: { name: 'title', before: 'x', after: null } }),
      ev('setAttr', '#cta', { attrChange: { name: 'rel', before: 'n', after: 'n' } }),
    ];

    const { folded } = foldMutationEvents(edit, events);

    expect(folded.attrs).toEqual([
      { name: 'href', before: null, after: '/b' },
      { name: 'title', before: 'x', after: null },
    ]);
  });

  // #9 round-2 review fix: the class merge is a WINDOW SET-DIFF — the FIRST class-relevant
  // event's before-classAttr vs the LAST's after-classAttr — not op parity. Class-relevant =
  // classChange OR attrChange.name === 'class'. The fixtures below carry the realistic
  // classAttr strings the producer emits (the old parity fixtures had empty before/after —
  // their PREMISE no longer pins anything under a diff).
  it('add→remove→add nets {op:add}', () => {
    const edit = anEdit();
    const events = [
      ev('addClass', '#cta', {
        before: '',
        after: 'hero',
        classChange: { name: 'hero', op: 'add' },
      }),
      ev('removeClass', '#cta', {
        before: 'hero',
        after: '',
        classChange: { name: 'hero', op: 'remove' },
      }),
      ev('addClass', '#cta', {
        before: '',
        after: 'hero',
        classChange: { name: 'hero', op: 'add' },
      }),
    ];

    const { folded } = foldMutationEvents(edit, events);

    expect(folded.classes).toEqual([{ name: 'hero', op: 'add' }]);
  });

  it('add→remove nets nothing — and the truthfully-empty family REPLACES the model’s classes', () => {
    const edit = anEdit({ classes: [{ name: 'model-class', op: 'add' }] });
    const events = [
      ev('addClass', '#cta', {
        before: '',
        after: 'flip',
        classChange: { name: 'flip', op: 'add' },
      }),
      ev('removeClass', '#cta', {
        before: 'flip',
        after: '',
        classChange: { name: 'flip', op: 'remove' },
      }),
    ];

    const { folded } = foldMutationEvents(edit, events);

    // Window before '' → after '': no net change. Ground truth says so — the model's stale
    // 'model-class' must NOT stand.
    expect(folded.classes).toEqual([]);
  });

  it('a present class + no-op add + remove nets {op:remove} (the no-op emitted no event)', () => {
    const edit = anEdit();
    // The element already had the class, so the model's addClass was a no-op and the producer
    // emitted NOTHING for it — the only real delta buffered is the remove.
    const events = [
      ev('removeClass', '#cta', {
        before: 'gone',
        after: '',
        classChange: { name: 'gone', op: 'remove' },
      }),
    ];

    const { folded } = foldMutationEvents(edit, events);

    expect(folded.classes).toEqual([{ name: 'gone', op: 'remove' }]);
  });

  it('diffs each class name independently across the group', () => {
    const edit = anEdit();
    // A realistic chain on an element that started with class 'gone'.
    const events = [
      ev('addClass', '#cta', {
        before: 'gone',
        after: 'gone keep',
        classChange: { name: 'keep', op: 'add' },
      }),
      ev('addClass', '#cta', {
        before: 'gone keep',
        after: 'gone keep flip',
        classChange: { name: 'flip', op: 'add' },
      }),
      ev('removeClass', '#cta', {
        before: 'gone keep flip',
        after: 'gone keep',
        classChange: { name: 'flip', op: 'remove' }, // cancels
      }),
      ev('removeClass', '#cta', {
        before: 'gone keep',
        after: 'keep',
        classChange: { name: 'gone', op: 'remove' },
      }),
    ];

    const { folded } = foldMutationEvents(edit, events);

    expect(folded.classes).toEqual([
      { name: 'keep', op: 'add' },
      { name: 'gone', op: 'remove' },
    ]);
  });

  it('a setAttr(class) interleave feeds the same window (x and y both net add)', () => {
    const edit = anEdit();
    const events = [
      ev('addClass', '#cta', {
        before: '',
        after: 'x',
        classChange: { name: 'x', op: 'add' },
      }),
      // The model rewrote the whole class list mid-group — a class-relevant event whose
      // classAttr strings live on the attrChange (null ⇒ '').
      ev('setAttr', '#cta', { attrChange: { name: 'class', before: 'x', after: 'y' } }),
      ev('addClass', '#cta', {
        before: 'y',
        after: 'y x',
        classChange: { name: 'x', op: 'add' },
      }),
    ];

    const { folded } = foldMutationEvents(edit, events);

    // Window '' → 'y x': both net add, in first-appearance order in the after string.
    expect(folded.classes).toEqual([
      { name: 'y', op: 'add' },
      { name: 'x', op: 'add' },
    ]);
    // ...and the setAttr('class') is SKIPPED in attrs (the classes family is canonical —
    // an attr entry would contradict it). The model's attrs stand untouched.
    expect(folded.attrs).toEqual([]);
  });

  it('page churn between two adds ([add, add] shape) still nets add — parity dropped this', () => {
    const edit = anEdit();
    // Page JS removed the class between the two addClass calls, so the second add was a REAL
    // delta again. Parity read the pair as a cancel; the window diff sees '' → 'x'.
    const events = [
      ev('addClass', '#cta', {
        before: '',
        after: 'x',
        classChange: { name: 'x', op: 'add' },
      }),
      ev('addClass', '#cta', {
        before: '',
        after: 'x',
        classChange: { name: 'x', op: 'add' },
      }),
    ];

    const { folded } = foldMutationEvents(edit, events);

    expect(folded.classes).toEqual([{ name: 'x', op: 'add' }]);
  });

  it('merges textChange first-before / last-after', () => {
    const edit = anEdit();
    const events = [
      ev('setText', '#cta', { textChange: { before: 'Buy', after: 'Buy now' } }),
      ev('setText', '#cta', { textChange: { before: 'Buy now', after: 'Buy now!' } }),
    ];

    const { folded } = foldMutationEvents(edit, events);

    expect(folded.text).toEqual({ before: 'Buy', after: 'Buy now!' });
  });

  it('unions frameworkHints (model first) deduped by value', () => {
    const edit = anEdit({ frameworkHints: ['tailwind', 'css-module'] });
    const events = [
      ev('addClass', '#cta', { frameworkHints: ['tailwind', 'styled'] }),
      ev('setStyle', '#cta', { frameworkHints: ['emotion'] }),
    ];

    const { folded } = foldMutationEvents(edit, events);

    expect(folded.frameworkHints).toEqual(['tailwind', 'css-module', 'styled', 'emotion']);
  });
});

describe('foldMutationEvents: selector healing', () => {
  // #9 round-2 review fix: with events in hand, the fold adopts the FIRST event's selector —
  // the one that actually resolved on the page (strategy + fragile included).
  it('heals a model paraphrase to the event’s selector (strategy + fragile adopted)', () => {
    const edit = anEdit({ selector: sel('.hero .cta') }); // the model's paraphrase
    const eventSelector: StableSelector = { value: '#cta', strategy: 'id', fragile: false };
    const events = [
      ev('setStyle', '#cta', {
        selector: eventSelector,
        styleChanges: [{ prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(1, 2, 3)' }],
      }),
    ];

    const { folded } = foldMutationEvents(edit, events);

    expect(folded.selector).toEqual(eventSelector);
  });

  it('an exact-match drain heals to the same value (no-op-ish)', () => {
    const edit = anEdit();
    const events = [ev('setStyle', '#cta')];

    const { folded } = foldMutationEvents(edit, events);

    expect(folded.selector).toEqual(edit.selector);
  });
});

describe('foldMutationEvents: structural spillover', () => {
  it('folds the first structural op and spills the additional one into its own auto-recorded edit', () => {
    const edit = anEdit();
    const first = {
      op: 'insert' as const,
      html: '<div class="banner">x</div>',
      position: 'beforeend' as const,
    };
    const second = {
      op: 'insert' as const,
      html: '<span class="chip">y</span>',
      position: 'beforeend' as const,
    };
    const events = [
      ev('insertNode', '#cta', { structural: first, frameworkHints: ['tailwind'] }),
      ev('insertNode', '#cta', { structural: second }),
    ];

    const { folded, spillover } = foldMutationEvents(edit, events);

    expect(folded.structural).toEqual(first);
    expect(spillover).toHaveLength(1);
    const extra = spillover[0];
    expect(extra?.intent).toBe('Auto-recorded structural edit (additional op on same selector)');
    expect(extra?.structural).toEqual(second);
    // The spillover edit carries ONLY the structural delta + the group's own hint union.
    expect(extra?.changes).toEqual([]);
    expect(extra?.attrs).toEqual([]);
    expect(extra?.classes).toEqual([]);
    expect(extra?.selector).toEqual(events[0]?.selector); // the group's own selector
    expect(extra?.frameworkHints).toEqual(['tailwind']); // group hints, NOT the model's
    expect(extra?.breakpoint).toBeUndefined(); // the model edit had none
  });

  // #9 round-2 review fix: spillover edits ran under the same device emulation as the model's
  // edit, so they carry its breakpoint.
  it('spillover carries the model edit’s breakpoint', () => {
    const edit = anEdit({ breakpoint: 'iphone-14' });
    const events = [
      ev('insertNode', '#cta', { structural: { op: 'insert' as const, html: '<i>1</i>' } }),
      ev('removeNode', '#cta', { structural: { op: 'remove' as const } }),
    ];

    const { folded, spillover } = foldMutationEvents(edit, events);

    expect(folded.breakpoint).toBe('iphone-14');
    expect(spillover).toHaveLength(1);
    expect(spillover[0]?.breakpoint).toBe('iphone-14');
  });

  it('move-then-remove survives as folded move + spillover remove (no op silently dropped)', () => {
    const edit = anEdit();
    const move = {
      op: 'move' as const,
      refSelector: { value: '#target', strategy: 'css-path' as const, fragile: true },
      position: 'beforeend' as const,
    };
    const events = [
      ev('moveNode', '#cta', { structural: move }),
      ev('removeNode', '#cta', { structural: { op: 'remove' } }),
    ];

    const { folded, spillover } = foldMutationEvents(edit, events);

    expect(folded.structural).toEqual(move);
    expect(spillover).toHaveLength(1);
    expect(spillover[0]?.structural).toEqual({ op: 'remove' });
  });

  it('spills one edit per additional structural op, in arrival order', () => {
    const edit = anEdit();
    const events = [
      ev('insertNode', '#cta', { structural: { op: 'insert' as const, html: '<i>1</i>' } }),
      ev('insertNode', '#cta', { structural: { op: 'insert' as const, html: '<i>2</i>' } }),
      ev('removeNode', '#cta', { structural: { op: 'remove' as const } }),
    ];

    const { folded, spillover } = foldMutationEvents(edit, events);

    expect(folded.structural).toEqual({ op: 'insert', html: '<i>1</i>' });
    expect(spillover.map((e) => e.structural)).toEqual([
      { op: 'insert', html: '<i>2</i>' },
      { op: 'remove' },
    ]);
  });
});

describe('foldMutationEvents: ground truth wins per family', () => {
  it('replaces the model family the buffer supplied, keeps the ones it did not', () => {
    const edit = anEdit({
      changes: [{ prop: 'color', before: 'model-before', after: 'model-after' }],
      attrs: [{ name: 'data-x', before: null, after: 'model' }],
      classes: [{ name: 'model-class', op: 'add' }],
      text: { before: 'model', after: 'model!' },
      structural: { op: 'remove' },
    });
    const events = [
      ev('setStyle', '#cta', {
        styleChanges: [{ prop: 'color', before: 'real-before', after: 'real-after' }],
      }),
      ev('setAttr', '#cta', { attrChange: { name: 'data-y', before: null, after: 'real' } }),
    ];

    const { folded } = foldMutationEvents(edit, events);

    // Supplied families → the real deltas replace the model's.
    expect(folded.changes).toEqual([{ prop: 'color', before: 'real-before', after: 'real-after' }]);
    expect(folded.attrs).toEqual([{ name: 'data-y', before: null, after: 'real' }]);
    // Unsupplied families → the model's values stand.
    expect(folded.classes).toEqual([{ name: 'model-class', op: 'add' }]);
    expect(folded.text).toEqual({ before: 'model', after: 'model!' });
    expect(folded.structural).toEqual({ op: 'remove' });
  });

  it('an all-no-op merged family still wins (truthfully empty) over the model’s stale delta', () => {
    const edit = anEdit({
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
    });
    const events = [
      ev('setStyle', '#cta', {
        styleChanges: [{ prop: 'color', before: '#000', after: '#00f' }],
      }),
      ev('setStyle', '#cta', {
        styleChanges: [{ prop: 'color', before: '#00f', after: '#000' }],
      }),
    ];

    const { folded } = foldMutationEvents(edit, events);

    expect(folded.changes).toEqual([]); // applied then reverted = no net change
  });

  it('tolerates pre-#9 events (no optional fields): the model’s Edit stands unchanged', () => {
    const edit = anEdit({
      attrs: [{ name: 'data-x', before: null, after: 'model' }],
      frameworkHints: ['tailwind'],
    });
    const events = [ev('setStyle', '#cta'), ev('setAttr', '#cta')];

    const { folded, spillover } = foldMutationEvents(edit, events);

    expect(folded).toEqual(edit);
    expect(spillover).toEqual([]);
  });

  it('returns the edit unchanged for an empty drain', () => {
    const edit = anEdit();

    const { folded, spillover } = foldMutationEvents(edit, []);

    expect(folded).toBe(edit);
    expect(spillover).toEqual([]);
  });
});
