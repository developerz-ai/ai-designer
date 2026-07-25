import { describe, expect, it } from 'vitest';
import { createPendingMutations, foldMutationEvents } from '@/changeset/pending-mutations';
import type { Edit, StableSelector } from '@/shared/changeset';
import type { MutationEvent, MutationKind } from '@/shared/messages';

// pending-mutations unit: the SW-side #9 recorder buffer + the recordEdit fold. Buffer: append /
// exact-match drain / single-group implicit drain / per-tab cap / peekGroups / clear. Fold:
// first-before/last-after per family, class-op cancellation, structural first-wins, frameworkHints
// union, ground-truth-wins per family (incl. merged-empty replacing the model's stale delta), and
// back-compat with pre-#9 events that carry none of the optional mechanical fields.

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
    const a2 = ev('addClass', '#a');
    pending.append(TAB, a1);
    pending.append(TAB, b1);
    pending.append(TAB, a2);

    expect(pending.drain(TAB, '#a')).toEqual([a1, a2]);
    expect(pending.drain(TAB, '#a')).toEqual([]); // consumed
    expect(pending.drain(TAB, '#b')).toEqual([b1]);
    expect(pending.peekGroups(TAB)).toEqual([]);
  });

  it('drain with no selector value drains all when exactly one distinct value is buffered', () => {
    const pending = createPendingMutations();
    const a1 = ev('setStyle', '#a');
    const a2 = ev('setText', '#a');
    pending.append(TAB, a1);
    pending.append(TAB, a2);

    expect(pending.drain(TAB)).toEqual([a1, a2]);
    expect(pending.peekGroups(TAB)).toEqual([]);
  });

  it('drain with no selector value drains nothing when several distinct values are buffered', () => {
    const pending = createPendingMutations();
    pending.append(TAB, ev('setStyle', '#a'));
    pending.append(TAB, ev('setStyle', '#b'));

    expect(pending.drain(TAB)).toEqual([]);
    expect(pending.peekGroups(TAB)).toHaveLength(2); // buffer untouched
  });

  it('drains nothing for an unknown tab or selector', () => {
    const pending = createPendingMutations();
    pending.append(TAB, ev('setStyle', '#a'));

    expect(pending.drain(999)).toEqual([]);
    expect(pending.drain(TAB, '#nope')).toEqual([]);
    expect(pending.peekGroups(TAB)).toHaveLength(1); // untouched
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

    expect(pending.drain(TAB)).toEqual(events.slice(1));
  });

  it('clear wipes the tab buffer', () => {
    const pending = createPendingMutations();
    pending.append(TAB, ev('setStyle', '#a'));

    pending.clear(TAB);

    expect(pending.peekGroups(TAB)).toEqual([]);
    expect(pending.drain(TAB, '#a')).toEqual([]);
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

    const folded = foldMutationEvents(edit, events);

    expect(folded.changes).toEqual([
      { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
      { prop: 'margin', before: null, after: '8px' },
    ]);
  });

  it('merges attrChanges first-before / last-after per name and drops no-op pairs', () => {
    const edit = anEdit();
    const events = [
      ev('setAttr', '#cta', { attrChange: { name: 'href', before: null, after: '/a' } }),
      ev('setAttr', '#cta', { attrChange: { name: 'href', before: '/a', after: '/b' } }),
      ev('setAttr', '#cta', { attrChange: { name: 'title', before: 'x', after: null } }),
      ev('setAttr', '#cta', { attrChange: { name: 'rel', before: 'n', after: 'n' } }),
    ];

    const folded = foldMutationEvents(edit, events);

    expect(folded.attrs).toEqual([
      { name: 'href', before: null, after: '/b' },
      { name: 'title', before: 'x', after: null },
    ]);
  });

  it('cancels opposite class ops in either order and dedupes repeated ops', () => {
    const edit = anEdit();
    const events = [
      ev('addClass', '#cta', { classChange: { name: 'keep', op: 'add' } }),
      ev('addClass', '#cta', { classChange: { name: 'keep', op: 'add' } }), // repeat → single
      ev('addClass', '#cta', { classChange: { name: 'flip', op: 'add' } }),
      ev('removeClass', '#cta', { classChange: { name: 'flip', op: 'remove' } }), // cancels
      ev('removeClass', '#cta', { classChange: { name: 'flop', op: 'remove' } }),
      ev('addClass', '#cta', { classChange: { name: 'flop', op: 'add' } }), // cancels (other order)
      ev('removeClass', '#cta', { classChange: { name: 'gone', op: 'remove' } }),
    ];

    const folded = foldMutationEvents(edit, events);

    expect(folded.classes).toEqual([
      { name: 'keep', op: 'add' },
      { name: 'gone', op: 'remove' },
    ]);
  });

  it('lets the first drained structural event win and drops extras', () => {
    const edit = anEdit();
    const first = {
      op: 'insert' as const,
      html: '<div class="banner">x</div>',
      position: 'beforeend' as const,
    };
    const events = [
      ev('insertNode', '#cta', { structural: first }),
      ev('removeNode', '#cta', { structural: { op: 'remove' } }),
    ];

    const folded = foldMutationEvents(edit, events);

    expect(folded.structural).toEqual(first);
  });

  it('merges textChange first-before / last-after', () => {
    const edit = anEdit();
    const events = [
      ev('setText', '#cta', { textChange: { before: 'Buy', after: 'Buy now' } }),
      ev('setText', '#cta', { textChange: { before: 'Buy now', after: 'Buy now!' } }),
    ];

    const folded = foldMutationEvents(edit, events);

    expect(folded.text).toEqual({ before: 'Buy', after: 'Buy now!' });
  });

  it('unions frameworkHints (model first) deduped by value', () => {
    const edit = anEdit({ frameworkHints: ['tailwind', 'css-module'] });
    const events = [
      ev('addClass', '#cta', { frameworkHints: ['tailwind', 'styled'] }),
      ev('setStyle', '#cta', { frameworkHints: ['emotion'] }),
    ];

    const folded = foldMutationEvents(edit, events);

    expect(folded.frameworkHints).toEqual(['tailwind', 'css-module', 'styled', 'emotion']);
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

    const folded = foldMutationEvents(edit, events);

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

    const folded = foldMutationEvents(edit, events);

    expect(folded.changes).toEqual([]); // applied then reverted = no net change
  });

  it('tolerates pre-#9 events (no optional fields): the model’s Edit stands unchanged', () => {
    const edit = anEdit({
      attrs: [{ name: 'data-x', before: null, after: 'model' }],
      frameworkHints: ['tailwind'],
    });
    const events = [ev('setStyle', '#cta'), ev('setAttr', '#cta')];

    const folded = foldMutationEvents(edit, events);

    expect(folded).toEqual(edit);
  });

  it('returns the edit unchanged for an empty drain', () => {
    const edit = anEdit();

    expect(foldMutationEvents(edit, [])).toBe(edit);
  });
});
