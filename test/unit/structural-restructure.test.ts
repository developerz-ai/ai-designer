import { beforeEach, describe, expect, it } from 'vitest';
import { createMutator, MAX_WRAP_RANGE } from '@/dom/mutate';
import {
  applyStructuralBulk,
  bulkError,
  MAX_BULK_TARGETS,
  resolveTargets,
} from '@/dom/structural-bulk';

// The three restructuring primitives and the bulk form. Between them these are what turns "the
// agent can make HTML changes" from "it can move a node" into "it can restructure a page": a
// legacy <table> layout becomes semantic markup, and a repeated legacy artefact can be swept in
// one call instead of twelve.
//
// The bar every one of them is held to: ONE reversible mutation, exact restoration (not an
// approximation), honest refusal of an ambiguous request, and anchor validation so a page that
// churned under us reports rather than "reverts" into a detached tree.

const q = (selector: string): Element => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`fixture missing: ${selector}`);
  return el;
};

describe('wrapNode', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="list"><i>before</i><p id="a">A</p><span> </span><p id="b">B</p><i>after</i></div>';
  });

  it('wraps a single element in place', () => {
    const m = createMutator(document).wrapNode(q('#a'), '<section class="stories"></section>');
    const wrapper = q('#list > section.stories');
    expect(wrapper.querySelector('#a')).not.toBeNull();
    // Position preserved: still between the two <i>s.
    expect(wrapper.previousElementSibling?.textContent).toBe('before');
    expect(m.computed.wrapped).toBe(1);
  });

  it('wraps a RANGE of siblings, taking the text nodes between them with it', () => {
    // The case that composing insert+move gets wrong. The whitespace <span> between the two
    // paragraphs belongs to the range; a range that leaves its own whitespace behind is not the
    // range the caller pointed at.
    createMutator(document).wrapNode(q('#a'), '<section></section>', q('#b'));
    const wrapper = q('#list > section');
    expect(Array.from(wrapper.children).map((c) => c.id || c.tagName)).toEqual(['a', 'SPAN', 'b']);
    // Nothing outside the range moved.
    expect(q('#list').firstElementChild?.textContent).toBe('before');
    expect(q('#list').lastElementChild?.textContent).toBe('after');
  });

  it('restores the EXACT prior sibling order on undo, not an approximation', () => {
    const listBefore = q('#list').innerHTML;
    const m = createMutator(document).wrapNode(q('#a'), '<section></section>', q('#b'));
    m.undo();
    expect(q('#list').innerHTML).toBe(listBefore);
    expect(document.querySelector('section')).toBeNull();
  });

  it('is ONE mutation — a single undo leaves no half-built wrapper', () => {
    // Composed from insertNode + moveNode this needs two undos, and one undo leaves an empty
    // <section> on the page.
    const m = createMutator(document).wrapNode(q('#a'), '<section></section>', q('#b'));
    m.undo();
    expect(document.querySelectorAll('section')).toHaveLength(0);
    expect(q('#list').children).toHaveLength(5);
  });

  it('refuses a range whose ends are not siblings', () => {
    document.body.innerHTML = '<div><p id="x">x</p></div><div><p id="y">y</p></div>';
    expect(() => createMutator(document).wrapNode(q('#x'), '<section></section>', q('#y'))).toThrow(
      /siblings/i,
    );
  });

  it('refuses a range given backwards instead of silently reinterpreting it', () => {
    expect(() => createMutator(document).wrapNode(q('#b'), '<section></section>', q('#a'))).toThrow(
      /before the range start/i,
    );
  });

  it('refuses markup that is not exactly one wrapper element', () => {
    const mutator = createMutator(document);
    expect(() => mutator.wrapNode(q('#a'), '<div></div><div></div>')).toThrow(/exactly one/i);
    expect(() => mutator.wrapNode(q('#a'), 'just text')).toThrow(/exactly one/i);
    // …but indentation around a single element is normal authored markup and is tolerated.
    expect(() => mutator.wrapNode(q('#a'), '\n  <section></section>\n')).not.toThrow();
  });

  it('sanitises the wrapper exactly like insertNode does', () => {
    createMutator(document).wrapNode(q('#a'), '<section onclick="alert(1)"><b>x</b></section>');
    expect(q('#list > section').hasAttribute('onclick')).toBe(false);
  });

  it('bounds the range so one bad selector cannot absorb a document', () => {
    const cells = Array.from({ length: MAX_WRAP_RANGE + 5 }, () => '<p></p>').join('');
    document.body.innerHTML = `<div id="big">${cells}</div>`;
    const kids = q('#big').children;
    const first = kids[0];
    const last = kids[kids.length - 1];
    if (!first || !last) throw new Error('fixture');
    expect(() => createMutator(document).wrapNode(first, '<section></section>', last)).toThrow(
      /exceeds/i,
    );
  });

  it('refuses to undo into a page that moved the anchor out from under it', () => {
    const m = createMutator(document).wrapNode(q('#a'), '<section></section>');
    q('#list').remove(); // the SPA re-rendered; the original parent is gone
    expect(() => m.undo()).toThrow(/page updated/i);
  });
});

describe('unwrapNode', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<main><center id="legacy"><p id="one">1</p><p id="two">2</p></center><hr></main>';
  });

  it('drops the wrapper and leaves the children exactly where they were', () => {
    const m = createMutator(document).unwrapNode(q('#legacy'));
    expect(document.querySelector('center')).toBeNull();
    expect(Array.from(q('main').children).map((c) => c.id || c.tagName)).toEqual([
      'one',
      'two',
      'HR',
    ]);
    expect(m.computed.unwrapped).toBe(2);
  });

  it('restores the nesting and the wrapper position on undo', () => {
    const before = q('main').innerHTML;
    const m = createMutator(document).unwrapNode(q('#legacy'));
    m.undo();
    expect(q('main').innerHTML).toBe(before);
  });

  it('retains node identity for the wrapper AND its children, so state survives undo', () => {
    const wrapper = q('#legacy');
    const child = q('#one');
    const m = createMutator(document).unwrapNode(wrapper);
    m.undo();
    // Same objects, not re-parsed copies — listeners and framework state come back with them.
    expect(q('#legacy')).toBe(wrapper);
    expect(q('#one')).toBe(child);
  });

  it('reports rather than reverting into a detached tree', () => {
    const m = createMutator(document).unwrapNode(q('#legacy'));
    q('main').remove();
    expect(() => m.undo()).toThrow(/page updated/i);
  });
});

describe('replaceSubtree', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<main><table id="t"><tbody><tr><td>Story</td></tr></tbody></table><hr></main>';
  });

  it('swaps a whole subtree for new markup in one step', () => {
    const m = createMutator(document).replaceSubtree(
      q('#t'),
      '<section class="stories"><ul><li>Story</li></ul></section>',
    );
    expect(document.querySelector('table')).toBeNull();
    expect(q('main > section.stories > ul > li').textContent).toBe('Story');
    // Position preserved — the <hr> still follows it.
    expect(q('main').lastElementChild?.tagName).toBe('HR');
    expect(m.before).toContain('<table');
  });

  it('is ONE reversible mutation, not a remove plus an insert', () => {
    // Two mutations would mean two undo entries: one undo restores the table while the replacement
    // is still on the page, or removes the replacement and leaves a hole.
    const before = q('main').innerHTML;
    const table = q('#t');
    const m = createMutator(document).replaceSubtree(q('#t'), '<section></section>');
    m.undo();
    expect(q('main').innerHTML).toBe(before);
    expect(document.querySelector('section')).toBeNull();
    expect(q('#t')).toBe(table); // clipboard-retained, so listeners and state came back
  });

  it('refuses a replacement that sanitises down to nothing', () => {
    // Silently deleting the subtree would be an unreviewable surprise; removeNode records a
    // deletion truthfully.
    expect(() => createMutator(document).replaceSubtree(q('#t'), '<script>x()</script>')).toThrow(
      /removeNode/,
    );
  });

  it('reports rather than reverting into a detached tree', () => {
    const m = createMutator(document).replaceSubtree(q('#t'), '<section></section>');
    q('main').remove();
    expect(() => m.undo()).toThrow(/page updated/i);
  });
});

describe('bulk structural editing', () => {
  beforeEach(() => {
    document.body.innerHTML = `<table><tbody>
      <tr class="athing"><td>1</td></tr><tr class="spacer"></tr>
      <tr class="athing"><td>2</td></tr><tr class="spacer"></tr>
      <tr class="athing"><td>3</td></tr><tr class="spacer"></tr>
    </tbody></table>`;
  });

  const describe_ = (el: Element): string => el.className || el.tagName.toLowerCase();

  it('removes every match in one call — the 12-round-trip action', () => {
    const mutator = createMutator(document);
    const { targets } = resolveTargets(document, '.spacer');
    const outcome = applyStructuralBulk(targets, (el) => mutator.removeNode(el), {
      describe: describe_,
    });

    expect(outcome.applied).toBe(3);
    expect(outcome.failed).toBe(0);
    expect(document.querySelectorAll('.spacer')).toHaveLength(0);
    // …and the caller still gets one mutation per element, so undo granularity is per-row.
    expect(outcome.mutations).toHaveLength(3);
    for (const { mutation } of [...outcome.mutations].reverse()) mutation.undo();
    expect(document.querySelectorAll('.spacer')).toHaveLength(3);
  });

  it('resolves every target BEFORE mutating any of them', () => {
    // The property the signature enforces: the applier never sees a selector, so it cannot
    // re-query between ops and pick up a tree an earlier op just reshaped.
    const mutator = createMutator(document);
    const { targets } = resolveTargets(document, 'tr');
    const seen: number[] = [];
    applyStructuralBulk(
      targets,
      (el) => {
        seen.push(document.querySelectorAll('tr').length);
        return mutator.removeNode(el);
      },
      { describe: describe_ },
    );
    // The live DOM shrinks under us…
    expect(seen[0]).toBe(6);
    expect(seen[5]).toBe(1);
    // …and every target was still visited, because the set was fixed up front.
    expect(seen).toHaveLength(6);
  });

  it('skips a target an earlier target contained, and says so', () => {
    document.body.innerHTML = '<div class="x" id="outer"><div class="x" id="inner"></div></div>';
    const mutator = createMutator(document);
    const { targets } = resolveTargets(document, '.x');
    const outcome = applyStructuralBulk(targets, (el) => mutator.removeNode(el), {
      describe: (el) => el.id,
    });

    expect(outcome.applied).toBe(1);
    expect(outcome.results[1]).toMatchObject({ index: 1, selector: 'inner', ok: false });
    expect(outcome.results[1]?.error).toMatch(/left the document/i);
    // The critical part: the nested target was NOT reported as an edit the user can never see.
    expect(outcome.mutations).toHaveLength(1);
  });

  it('keeps going past a refused target and names the ones that failed', () => {
    const mutator = createMutator(document);
    const { targets } = resolveTargets(document, '.spacer');
    const outcome = applyStructuralBulk(targets, (el) => mutator.removeNode(el), {
      describe: describe_,
      guard: (el) => (el === targets[1] ? 'Refused: policy' : null),
    });

    expect([outcome.applied, outcome.failed]).toEqual([2, 1]);
    expect(bulkError(outcome)).toContain('#1 (spacer)');
    expect(bulkError(outcome)).toContain('already live');
  });

  it('refuses outright over the cap rather than half-applying an edit', () => {
    document.body.innerHTML = Array.from(
      { length: MAX_BULK_TARGETS + 1 },
      () => '<p class="many"></p>',
    ).join('');
    const outcome = resolveTargets(document, '.many');
    expect(outcome.targets).toHaveLength(0);
    expect(outcome.note).toContain(`capped at ${MAX_BULK_TARGETS}`);
  });

  it('works with wrapNode too — one operation applied to a set', () => {
    const mutator = createMutator(document);
    const { targets } = resolveTargets(document, '.athing');
    const outcome = applyStructuralBulk(
      targets,
      (el) => mutator.wrapNode(el, '<tbody class="group"></tbody>'),
      { describe: describe_ },
    );
    expect(outcome.applied).toBe(3);
    expect(document.querySelectorAll('tbody.group')).toHaveLength(3);
  });
});
