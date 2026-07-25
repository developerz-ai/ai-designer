import { describe, expect, it } from 'vitest';
import {
  findLastMatchingEditIndex,
  retractFromEdits,
  stripEventFromEdit,
} from '@/changeset/revert-match';
import { TEXT_CHANGE_BEFORE_CAP } from '@/dom/mutate';
import type { Edit } from '@/shared/changeset';
import type { MutationEvent, MutationKind } from '@/shared/messages';

// revert-match unit (#9 rounds 3+4+5): the durable-record half of recorder-revert. A late revert
// (event already drained/finalized) must retract the LAST kind-consistent edit on the SAME
// selector — and never touch other elements or other kinds. Round 4: the retraction is SURGICAL
// (stripEventFromEdit removes only the reverted event's contribution; an all-empty result removes
// the edit), and the setAttr matcher mirrors the fold's class routing. Round 5: a capped
// textChange.before makes the one-hop restore un-reconstructable (drop the family, never write a
// maybe-truncated value), and retractFromEdits is the ONE shared matcher both callers drive —
// scanning for the newest consistent edit whose strip CHANGES something and failing CLOSED
// (dropping the covered entries) when no consistent edit value-matches (a broken LIFO).

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

  // #9 round-3 blind spot, fixed round-4: the fold routes a setAttr('class') into the CLASSES
  // family (mergeAttrChanges skips it), so the matcher must look there — else a wholesale class
  // rewrite's revert never matches the edit its own fold produced.
  it('a setAttr(class) revert matches a classes-bearing edit (the fold routes it there, not attrs)', () => {
    const edits = [
      anEdit({ attrs: [{ name: 'data-variant', before: null, after: 'brand' }] }),
      anEdit({ classes: [{ name: 'hero', op: 'add' }] }),
    ];
    const event = ev('setAttr', '#cta', {
      attrChange: { name: 'class', before: '', after: 'hero' },
    });
    expect(findLastMatchingEditIndex(edits, event)).toBe(1);
  });

  it('a setAttr(class) revert does NOT match an attrs-only edit', () => {
    const edits = [anEdit({ attrs: [{ name: 'data-variant', before: null, after: 'brand' }] })];
    const event = ev('setAttr', '#cta', {
      attrChange: { name: 'class', before: 'a', after: 'b' },
    });
    expect(findLastMatchingEditIndex(edits, event)).toBe(-1);
  });

  it('a pre-#9 raw setAttr (no attrChange) matches nothing', () => {
    const edits = [anEdit({ attrs: [{ name: 'data-variant', before: null, after: 'brand' }] })];
    expect(findLastMatchingEditIndex(edits, ev('setAttr', '#cta'))).toBe(-1);
  });
});

describe('stripEventFromEdit (surgical retraction)', () => {
  it('merged-style partial revert: E1 red + E2 blue folded to one edit; reverting E2 restores E1’s value', () => {
    // E1 (#000 → #f00) then E2 (#f00 → #00f) merged into one changes entry {before #000,
    // after #00f}. Reverting E2 steps the prop back one hop — the edit SURVIVES with E1's delta.
    const edit = anEdit({ changes: [{ prop: 'color', before: '#000', after: '#00f' }] });
    const event = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'color', before: '#f00', after: '#00f' }],
    });

    expect(stripEventFromEdit(edit, event)).toEqual(
      anEdit({ changes: [{ prop: 'color', before: '#000', after: '#f00' }] }),
    );
  });

  it('restores the reverted prop and leaves sibling props; a drifted value (after ≠ sc.after) is untouched', () => {
    const edit = anEdit({
      changes: [
        { prop: 'color', before: '#000', after: '#00f' },
        { prop: 'margin', before: null, after: '8px' },
      ],
    });
    const touched = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'color', before: '#000', after: '#00f' }],
    });
    // color restores to its original ⇒ the pair dies; margin (no sc) survives.
    expect(stripEventFromEdit(edit, touched)?.changes).toEqual([
      { prop: 'margin', before: null, after: '8px' },
    ]);

    const drifted = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'color', before: '#000', after: '#0f0' }], // the edit holds #00f
    });
    expect(stripEventFromEdit(edit, drifted)?.changes).toEqual(edit.changes);
  });

  it('a revert of an ADDED prop (sc.before null) drops the pair outright', () => {
    const edit = anEdit({ changes: [{ prop: 'margin', before: null, after: '8px' }] });
    const event = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'margin', before: null, after: '8px' }],
    });
    expect(stripEventFromEdit(edit, event)).toBeNull(); // nothing remains ⇒ caller removes
  });

  it('a pre-#9 style event (no styleChanges) strips every candidate pair, other families survive', () => {
    const edit = anEdit({
      changes: [
        { prop: 'color', before: '#000', after: '#00f' },
        { prop: 'margin', before: null, after: '8px' },
      ],
      attrs: [{ name: 'data-x', before: null, after: '1' }],
    });
    expect(stripEventFromEdit(edit, ev('setStyle', '#cta'))).toEqual(
      anEdit({ attrs: [{ name: 'data-x', before: null, after: '1' }] }),
    );
  });

  it('returns null when the strip empties every family (strip-to-null ⇒ remove)', () => {
    const edit = anEdit({ changes: [{ prop: 'color', before: '#000', after: '#00f' }] });
    const event = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'color', before: '#000', after: '#00f' }],
    });
    expect(stripEventFromEdit(edit, event)).toBeNull();
  });

  it('mixed-family partial strip: only the reverted family is touched', () => {
    const edit = anEdit({
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
      attrs: [{ name: 'data-variant', before: null, after: 'brand' }],
    });
    const event = ev('setAttr', '#cta', {
      attrChange: { name: 'data-variant', before: null, after: 'brand' },
    });
    const stripped = stripEventFromEdit(edit, event);
    expect(stripped?.changes).toEqual(edit.changes); // untouched
    expect(stripped?.attrs).toEqual([]); // restored to absent ⇒ the pair died
  });

  it('setAttr restores the pre-event value one hop back; drops the pair only when nothing net remains', () => {
    const edit = anEdit({ attrs: [{ name: 'href', before: '/a', after: '/c' }] });
    const stepBack = ev('setAttr', '#cta', {
      attrChange: { name: 'href', before: '/b', after: '/c' },
    });
    expect(stripEventFromEdit(edit, stepBack)?.attrs).toEqual([
      { name: 'href', before: '/a', after: '/b' }, // one step back, not removed
    ]);

    const full = ev('setAttr', '#cta', { attrChange: { name: 'href', before: '/a', after: '/c' } });
    expect(stripEventFromEdit(edit, full)).toBeNull(); // restored to /a = the original ⇒ dies
  });

  it('setAttr(class) strips the ENTIRE classes family (the window computation is invalidated)', () => {
    const edit = anEdit({
      classes: [
        { name: 'hero', op: 'add' },
        { name: 'sticky', op: 'add' },
      ],
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
    });
    const event = ev('setAttr', '#cta', {
      attrChange: { name: 'class', before: '', after: 'hero sticky' },
    });
    const stripped = stripEventFromEdit(edit, event);
    expect(stripped?.classes).toEqual([]);
    expect(stripped?.changes).toEqual(edit.changes); // other families untouched
  });

  it('addClass/removeClass strips the matching class entry only — matched by NAME, either op', () => {
    const edit = anEdit({
      classes: [
        { name: 'hero', op: 'add' },
        { name: 'sticky', op: 'add' },
      ],
    });
    const event = ev('removeClass', '#cta', { classChange: { name: 'hero', op: 'remove' } });
    expect(stripEventFromEdit(edit, event)?.classes).toEqual([{ name: 'sticky', op: 'add' }]);
  });

  it('setText restores the pre-event text and deletes the family when nothing net remains', () => {
    const edit = anEdit({ text: { before: 'Buy', after: 'Shop now' } });
    const stepBack = ev('setText', '#cta', { textChange: { before: 'Shop', after: 'Shop now' } });
    expect(stripEventFromEdit(edit, stepBack)?.text).toEqual({ before: 'Buy', after: 'Shop' });

    const full = ev('setText', '#cta', { textChange: { before: 'Buy', after: 'Shop now' } });
    expect(stripEventFromEdit(edit, full)).toBeNull();

    // A textChange that doesn't match the recorded after leaves the edit alone.
    const drifted = ev('setText', '#cta', { textChange: { before: 'x', after: 'y' } });
    expect(stripEventFromEdit(edit, drifted)?.text).toEqual({ before: 'Buy', after: 'Shop now' });
  });

  // #9 round 5: the producer caps textChange.before at TEXT_CHANGE_BEFORE_CAP — a capped value
  // may be truncated, so the one-hop restore would write a maybe-truncated value into the
  // durable record as if it were the full text. Fail closed: drop the text family instead.
  it('a capped textChange.before drops the text family instead of restoring a maybe-truncated value', () => {
    const edit = anEdit({
      text: { before: 'Buy', after: 'Shop now' },
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
    });
    // Exactly AT the cap — what the producer ships when it truncated the prior textContent.
    const capped = ev('setText', '#cta', {
      textChange: { before: 'x'.repeat(TEXT_CHANGE_BEFORE_CAP), after: 'Shop now' },
    });
    const stripped = stripEventFromEdit(edit, capped);
    expect(stripped?.text).toBeUndefined(); // the family dies — no truncated restore
    expect(stripped?.changes).toEqual(edit.changes); // other families untouched
  });

  it('an uncapped textChange.before still one-hop restores normally', () => {
    const edit = anEdit({ text: { before: 'Buy', after: 'Shop now' } });
    const short = ev('setText', '#cta', {
      textChange: { before: 'x'.repeat(TEXT_CHANGE_BEFORE_CAP - 1), after: 'Shop now' },
    });
    expect(stripEventFromEdit(edit, short)?.text).toEqual({
      before: 'Buy',
      after: 'x'.repeat(TEXT_CHANGE_BEFORE_CAP - 1),
    });
  });

  it('structural kinds delete the structural family; a structural-only edit becomes null', () => {
    const mixed = anEdit({
      structural: { op: 'remove' },
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
    });
    const stripped = stripEventFromEdit(mixed, ev('removeNode', '#cta'));
    expect(stripped?.structural).toBeUndefined();
    expect(stripped?.changes).toHaveLength(1);

    const only = anEdit({ structural: { op: 'insert', html: '<i>1</i>' } });
    expect(stripEventFromEdit(only, ev('insertNode', '#cta'))).toBeNull();
  });

  it('never touches intent, selector, frameworkHints, or breakpoint', () => {
    const edit = anEdit({
      intent: 'keep me',
      frameworkHints: ['tailwind'],
      breakpoint: 'iphone-14',
      classes: [{ name: 'hero', op: 'add' }],
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
    });
    const event = ev('addClass', '#cta', { classChange: { name: 'hero', op: 'add' } });
    const stripped = stripEventFromEdit(edit, event);
    expect(stripped?.intent).toBe('keep me');
    expect(stripped?.selector).toEqual(edit.selector);
    expect(stripped?.frameworkHints).toEqual(['tailwind']);
    expect(stripped?.breakpoint).toBe('iphone-14');
  });

  it('does not mutate the input edit (the store treats edits immutably)', () => {
    const edit = anEdit({
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
      classes: [{ name: 'hero', op: 'add' }],
    });
    const snapshot = JSON.parse(JSON.stringify(edit));
    stripEventFromEdit(edit, ev('addClass', '#cta', { classChange: { name: 'hero', op: 'add' } }));
    expect(edit).toEqual(snapshot);
  });
});

// #9 round 5: the ONE match+strip entry point BOTH retraction callers drive (the panel-ops
// `retract` op + the background mid-turn in-memory strip). Scan from the end for the newest
// consistent edit whose strip CHANGES something; when no consistent edit value-matches (a broken
// LIFO), fail closed — drop the entries the event covers from the NEWEST consistent edit, never
// keep the phantom.
describe('retractFromEdits (shared match + fail-closed drop)', () => {
  it('two-edit chain: reverting E1 kills edit1 (its pair nets to orig) and leaves edit2 standing', () => {
    // edit1 {color orig→red}, edit2 {color red→green}; the revert of E1 (sc.after = red) matches
    // NOTHING in edit2 (its after is green) — the scan walks past it to edit1, whose pair dies.
    const edit1 = anEdit({
      intent: 'e1',
      changes: [{ prop: 'color', before: 'orig', after: 'red' }],
    });
    const edit2 = anEdit({
      intent: 'e2',
      changes: [{ prop: 'color', before: 'red', after: 'green' }],
    });
    const event = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'color', before: 'orig', after: 'red' }],
    });

    const result = retractFromEdits([edit1, edit2], event);

    expect(result?.changedIndex).toBe(0);
    expect(result?.edits).toEqual([edit2]); // edit1 removed outright; edit2 untouched
  });

  it('merged fold: reverting E1 against the value-mismatched entry DROPS it (fail closed), never keeps it', () => {
    // E1 red + E2 green folded into ONE edit {color orig→green}; the revert of E1 (sc.after =
    // red) value-mismatches — a broken LIFO. Pre-round-5 the mismatched entry was silently kept.
    const merged = anEdit({ changes: [{ prop: 'color', before: 'orig', after: 'green' }] });
    const event = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'color', before: 'orig', after: 'red' }],
    });

    const result = retractFromEdits([merged], event);

    // color was the only family ⇒ dropping it removes the edit outright.
    expect(result).toEqual({ edits: [], changedIndex: 0 });
  });

  it('the fail-closed drop covers ONLY the event’s props — sibling props + other families survive', () => {
    const edit = anEdit({
      changes: [
        { prop: 'color', before: 'orig', after: 'green' },
        { prop: 'margin', before: null, after: '8px' },
      ],
      attrs: [{ name: 'data-x', before: null, after: '1' }],
    });
    const event = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'color', before: 'orig', after: 'red' }],
    });

    const result = retractFromEdits([edit], event);

    expect(result?.changedIndex).toBe(0);
    expect(result?.edits).toHaveLength(1);
    expect(result?.edits[0]?.changes).toEqual([{ prop: 'margin', before: null, after: '8px' }]);
    expect(result?.edits[0]?.attrs).toEqual([{ name: 'data-x', before: null, after: '1' }]);
  });

  it('attr analogue: a value-mismatched setAttr revert drops the named attr from the newest consistent edit', () => {
    const edit = anEdit({
      attrs: [{ name: 'href', before: '/a', after: '/c' }],
      classes: [{ name: 'hero', op: 'add' }],
    });
    const event = ev('setAttr', '#cta', {
      attrChange: { name: 'href', before: '/b', after: '/x' }, // the edit holds after '/c'
    });

    const result = retractFromEdits([edit], event);

    expect(result?.changedIndex).toBe(0);
    expect(result?.edits[0]?.attrs).toEqual([]); // dropped, not kept
    expect(result?.edits[0]?.classes).toEqual([{ name: 'hero', op: 'add' }]);
  });

  it('text analogue: a value-mismatched setText revert drops the text family', () => {
    const edit = anEdit({
      text: { before: 'Buy', after: 'Shop' },
      changes: [{ prop: 'color', before: '#000', after: '#00f' }],
    });
    const event = ev('setText', '#cta', { textChange: { before: 'x', after: 'y' } });

    const result = retractFromEdits([edit], event);

    expect(result?.changedIndex).toBe(0);
    expect(result?.edits[0]?.text).toBeUndefined();
    expect(result?.edits[0]?.changes).toEqual(edit.changes);
  });

  it('fail closed targets the NEWEST consistent edit when none value-matches', () => {
    const older = anEdit({
      intent: 'older',
      changes: [{ prop: 'color', before: 'a', after: 'b' }],
    });
    const newer = anEdit({
      intent: 'newer',
      changes: [{ prop: 'color', before: 'c', after: 'd' }],
    });
    const event = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'color', before: 'x', after: 'y' }],
    });

    const result = retractFromEdits([older, newer], event);

    expect(result?.changedIndex).toBe(1);
    expect(result?.edits).toEqual([older]); // the newer edit's sole family dropped ⇒ it died
  });

  it('a value-matched one-hop restore still wins over the fail-closed drop', () => {
    // Merged fold {color #000→#00f}, revert of the SECOND mutation (#f00→#00f): the strip
    // changes the edit (one hop back), so the fail-closed tier never engages.
    const edit = anEdit({ changes: [{ prop: 'color', before: '#000', after: '#00f' }] });
    const event = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'color', before: '#f00', after: '#00f' }],
    });

    const result = retractFromEdits([edit], event);

    expect(result?.changedIndex).toBe(0);
    expect(result?.edits[0]?.changes).toEqual([{ prop: 'color', before: '#000', after: '#f00' }]);
  });

  it('returns null when no edit is consistent at all (the caller no-ops)', () => {
    const edit = anEdit({
      selector: sel('#other'),
      changes: [{ prop: 'color', before: 'a', after: 'b' }],
    });
    const event = ev('setStyle', '#cta', {
      styleChanges: [{ prop: 'color', before: 'a', after: 'b' }],
    });
    expect(retractFromEdits([edit], event)).toBeNull(); // selector mismatch
    expect(retractFromEdits([], event)).toBeNull(); // nothing to match
  });

  it('never mutates the input list or its edits', () => {
    const edit = anEdit({ changes: [{ prop: 'color', before: 'orig', after: 'green' }] });
    const edits = [edit];
    const snapshot = JSON.parse(JSON.stringify(edits));
    retractFromEdits(
      edits,
      ev('setStyle', '#cta', { styleChanges: [{ prop: 'color', before: 'orig', after: 'red' }] }),
    );
    expect(edits).toEqual(snapshot);
  });
});
