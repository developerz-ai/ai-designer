import { describe, expect, it } from 'vitest';
import { ChangesetState, Edit, emptyChangeset } from '@/shared/changeset';

// changeset schema unit (#142): the Edit refines rejecting degenerate deltas — a null→null
// AttrChange (a no-op, not a change) and contradictory same-name class ops (add+remove in one
// edit). No producer emits these (the fold drops before===after pairs and diffs each class name
// once; setAttr always sets a string; revert-match only strips entries) — the refines guard the
// one free-form producer, the model's `recordEdit` args. Plus the baseline: a valid edit parses
// and a ChangesetState round-trips with the refines in place.

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const baseEdit = {
  intent: 'make it pop',
  selector: { value: '#cta', strategy: 'id', fragile: false },
};

describe('Edit schema: degenerate delta refines (#142)', () => {
  it('parses a valid edit and applies the array defaults', () => {
    const edit = Edit.parse(baseEdit);
    expect(edit.attrs).toEqual([]);
    expect(edit.classes).toEqual([]);
    expect(edit.frameworkHints).toEqual([]);
  });

  it('rejects an attr delta with before AND after both null', () => {
    const result = Edit.safeParse({
      ...baseEdit,
      attrs: [{ name: 'href', before: null, after: null }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/both null/);
  });

  it('accepts the one-sided attr nulls (absent → set, set → removed)', () => {
    expect(
      Edit.safeParse({ ...baseEdit, attrs: [{ name: 'href', before: null, after: '/buy' }] })
        .success,
    ).toBe(true);
    expect(
      Edit.safeParse({ ...baseEdit, attrs: [{ name: 'title', before: 'Buy', after: null }] })
        .success,
    ).toBe(true);
  });

  it('rejects add+remove of the same class in one edit, in either order', () => {
    const addThenRemove = Edit.safeParse({
      ...baseEdit,
      classes: [
        { name: 'hero', op: 'add' },
        { name: 'hero', op: 'remove' },
      ],
    });
    expect(addThenRemove.success).toBe(false);
    expect(addThenRemove.error?.issues[0]?.message).toMatch(/add and remove the same class/);

    const removeThenAdd = Edit.safeParse({
      ...baseEdit,
      classes: [
        { name: 'hero', op: 'remove' },
        { name: 'hero', op: 'add' },
      ],
    });
    expect(removeThenAdd.success).toBe(false);
  });

  it('accepts a repeated same-op class (redundant, not contradictory) and add+remove of DIFFERENT classes', () => {
    expect(
      Edit.safeParse({
        ...baseEdit,
        classes: [
          { name: 'hero', op: 'add' },
          { name: 'hero', op: 'add' },
        ],
      }).success,
    ).toBe(true);
    expect(
      Edit.safeParse({
        ...baseEdit,
        classes: [
          { name: 'hero', op: 'add' },
          { name: 'ghost', op: 'remove' },
        ],
      }).success,
    ).toBe(true);
  });

  it('still round-trips a ChangesetState (the rehydration unit) with the refines in place', () => {
    const state = {
      changeset: {
        ...emptyChangeset('https://example.com/', '2026-07-25T00:00:00Z', SESSION_ID),
        edits: [
          {
            ...baseEdit,
            attrs: [{ name: 'href', before: null, after: '/buy' }],
            classes: [{ name: 'hero', op: 'add' }],
          },
        ],
      },
      redoStack: [],
    };
    const parsed = ChangesetState.safeParse(state);
    expect(parsed.success).toBe(true);
  });
});
