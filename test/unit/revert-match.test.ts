import { describe, expect, it } from 'vitest';
import { findLastMatchingEditIndex } from '@/changeset/revert-match';
import type { Edit } from '@/shared/changeset';
import type { MutationEvent, MutationKind } from '@/shared/messages';

// revert-match unit (#9 round-3): the durable-record half of recorder-revert. A late revert
// (event already drained/finalized) must retract the LAST kind-consistent edit on the SAME
// selector — and never touch other elements or other kinds.

const sel = (value: string) => ({ value, strategy: 'id' as const, fragile: false });

const anEdit = (overrides: Partial<Edit> = {}): Edit => ({
  intent: 'edit',
  selector: sel('#cta'),
  changes: [],
  attrs: [],
  classes: [],
  frameworkHints: [],
  ...overrides,
});

const ev = (kind: MutationKind, selectorValue: string, extra: Partial<MutationEvent> = {}) => ({
  kind,
  selector: sel(selectorValue),
  before: '',
  after: '',
  ts: 1,
  ...extra,
});

describe('findLastMatchingEditIndex', () => {
  it('matches a setStyle revert against a style-bearing edit on the same prop', () => {
    const edits = [
      anEdit({ changes: [{ prop: 'color', before: '#000', after: '#00f' }] }),
      anEdit({ changes: [{ prop: 'font-size', before: '16px', after: '20px' }] }),
    ];
    const event = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'font-size', before: '16px', after: '20px' }],
    });
    expect(findLastMatchingEditIndex(edits, event)).toBe(1);
  });

  it('a pre-#9 setStyle event (no styleChanges) matches any style-bearing edit on the element', () => {
    const edits = [anEdit({ changes: [{ prop: 'color', before: '#000', after: '#00f' }] })];
    expect(findLastMatchingEditIndex(edits, ev('setStyle', '#cta'))).toBe(0);
    expect(findLastMatchingEditIndex(edits, ev('setStyle', '#other'))).toBe(-1);
  });

  it('LAST consistent edit wins (LIFO unwind order)', () => {
    const edits = [
      anEdit({ intent: 'first', changes: [{ prop: 'color', before: '#000', after: '#00f' }] }),
      anEdit({ intent: 'second', changes: [{ prop: 'color', before: '#00f', after: '#0f0' }] }),
    ];
    const event = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'color', before: '#00f', after: '#0f0' }],
    });
    expect(findLastMatchingEditIndex(edits, event)).toBe(1);
  });

  it('setAttr matches on the attribute name; addClass/removeClass on the class name', () => {
    const edits = [
      anEdit({ attrs: [{ name: 'data-variant', before: null, after: 'brand' }] }),
      anEdit({ classes: [{ name: 'btn-primary', op: 'add' }] }),
    ];
    expect(
      findLastMatchingEditIndex(
        edits,
        ev('setAttr', '#cta', { attrChange: { name: 'data-variant', before: null, after: 'x' } }),
      ),
    ).toBe(0);
    expect(
      findLastMatchingEditIndex(
        edits,
        ev('addClass', '#cta', { classChange: { name: 'btn-primary', op: 'add' } }),
      ),
    ).toBe(1);
    // A different attr/class name is NOT consistent.
    expect(
      findLastMatchingEditIndex(
        edits,
        ev('setAttr', '#cta', { attrChange: { name: 'data-other', before: null, after: 'x' } }),
      ),
    ).toBe(-1);
  });

  it('setText matches a text edit; structural kinds match a structural edit', () => {
    const edits = [
      anEdit({ text: { before: 'Buy', after: 'Shop' } }),
      anEdit({ structural: { op: 'remove' } }),
    ];
    expect(findLastMatchingEditIndex(edits, ev('setText', '#cta'))).toBe(0);
    expect(findLastMatchingEditIndex(edits, ev('removeNode', '#cta'))).toBe(1);
    expect(findLastMatchingEditIndex(edits, ev('insertNode', '#cta'))).toBe(1);
  });

  it('never crosses selectors, even when the kind payload matches', () => {
    const edits = [anEdit({ selector: sel('#sidebar'), classes: [{ name: 'sticky', op: 'add' }] })];
    expect(
      findLastMatchingEditIndex(
        edits,
        ev('addClass', '#cta', { classChange: { name: 'sticky', op: 'add' } }),
      ),
    ).toBe(-1);
  });

  it('returns -1 for an empty changeset', () => {
    expect(findLastMatchingEditIndex([], ev('setStyle', '#cta'))).toBe(-1);
  });
});
