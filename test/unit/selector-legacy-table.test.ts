import { beforeEach, describe, expect, it } from 'vitest';
import { isVolatileId, pickUnique } from '@/dom/selector';

// The adversarial input the selector engine actually meets in the wild: a legacy <table> layout
// with no data attributes, database-key ids, and a handful of author-written class names. This
// fixture is a faithful reduction of news.ycombinator.com — the page a real session produced ~15
// edits against, every one of them carrying an nth-of-type chain the changeset itself marked
// fragile (`#hnmain > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(…)`).
//
// What these assert is not "the engine is perfect here" — on a page like this many elements have
// no stable handle at all, and that is a property of the page. They assert two things the engine
// owes its consumer: it must take the BEST handle the markup actually offers (a class name, a
// landmark tag) instead of walking to the document root, and when it can only offer a positional
// or record-keyed value it must SAY SO. The changeset becomes a PR brief; a selector that silently
// claims to be stable is worse than one that admits it isn't.

const HN = `
<center>
<table id="hnmain" border="0" cellpadding="0" cellspacing="0" width="85%" bgcolor="#f6f6ef">
<tbody>
  <tr><td bgcolor="#ff6600" id="bigbox"><table border="0" width="100%"><tbody><tr>
    <td style="width:18px"><a href="https://news.ycombinator.com"><img width="18" height="18"></a></td>
    <td style="line-height:12pt"><span class="pagetop"><b class="hnname"><a href="news">Hacker News</a></b>
      <a href="newest">new</a> | <a href="front">past</a> | <a href="newcomments">comments</a></span></td>
    <td style="text-align:right"><span class="pagetop"><a href="login?goto=news">login</a></span></td>
  </tr></tbody></table></td></tr>
  <tr id="pagespace" style="height:10px"></tr>
  <tr><td>
    <table border="0" class="itemlist"><tbody>
      <tr class="athing submission" id="49299222">
        <td align="right" valign="top" class="title"><span class="rank">1.</span></td>
        <td valign="top" class="votelinks"><center><a id="up_49299222" href="vote?id=49299222"><div class="votearrow" title="upvote"></div></a></center></td>
        <td class="title"><span class="titleline"><a href="https://example.com/x">A story title</a><span class="sitebit comhead"> (<a href="from?site=example.com"><span class="sitestr">example.com</span></a>)</span></span></td>
      </tr>
      <tr><td colspan="2"></td><td class="subtext"><span class="subline"><span class="score" id="score_49299222">128 points</span> by <a href="user?id=alice" class="hnuser">alice</a> <span class="age"><a href="item?id=49299222">3 hours ago</a></span> | <a href="item?id=49299222">42 comments</a></span></td></tr>
      <tr class="spacer" style="height:5px"></tr>
      <tr class="athing submission" id="49299111">
        <td align="right" valign="top" class="title"><span class="rank">2.</span></td>
        <td valign="top" class="votelinks"><center><a id="up_49299111" href="vote?id=49299111"><div class="votearrow" title="upvote"></div></a></center></td>
        <td class="title"><span class="titleline"><a href="https://other.org/y">Another story</a><span class="sitebit comhead"> (<a href="from?site=other.org"><span class="sitestr">other.org</span></a>)</span></span></td>
      </tr>
      <tr><td colspan="2"></td><td class="subtext"><span class="subline"><span class="score" id="score_49299111">7 points</span> by <a href="user?id=bob" class="hnuser">bob</a> <span class="age"><a href="item?id=49299111">1 hour ago</a></span> | <a href="item?id=49299111">3 comments</a></span></td></tr>
    </tbody></table>
  </td></tr>
</tbody>
</table>
</center>`;

function q(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`fixture missing: ${selector}`);
  return found;
}

/** How many `nth-of-type` steps a value walks — the positional depth that makes a selector
 *  unmappable to source. `0` means the value names the element outright. */
function positionalDepth(value: string): number {
  return value.split('nth-of-type').length - 1;
}

describe('selector engine on a legacy table page (HN-shaped)', () => {
  beforeEach(() => {
    document.body.innerHTML = HN;
  });

  it('names <body> by its tag instead of walking to the document root', () => {
    // Was: `html > body:nth-of-type(1)`, flagged fragile — a positional path to the one element on
    // every page that needs none. `body` is unique by definition.
    const picked = pickUnique(document.body, document);
    expect(picked.value).toBe('body');
    expect(picked.fragile).toBe(false);
  });

  it('anchors on an author-written class rather than a chain from the page root', () => {
    // Was: `#hnmain > tbody:nth-of-type(1) > tr:nth-of-type(3) > td:nth-of-type(1) >
    // table:nth-of-type(1)`. `.itemlist` is a NAME — the one thing on this page a developer can
    // grep for in the template.
    const picked = pickUnique(q('.itemlist'), document);
    expect(picked.value).toBe('table.itemlist');
    expect(positionalDepth(picked.value)).toBe(0);
    expect(picked.fragile).toBe(false);
  });

  it('flags a record-key id as fragile even though it resolves today', () => {
    // `<tr id="49299222">` is a Hacker News story id — a database row, not a name. It uniquely
    // resolves on THIS page load and is gone on the next, so it stays the ranked winner (a
    // positional chain would be no better) but must not be reported as a stable handle.
    const picked = pickUnique(q('[id="49299222"]'), document);
    expect(picked.strategy).toBe('id');
    expect(picked.fragile).toBe(true);
  });

  it('hangs a path off the nearest NAMED ancestor, not the page root', () => {
    // Was 8 positional steps from `#hnmain`. The row itself has no unique handle (there are two
    // `.subtext` cells), so a path is unavoidable — but it should start at `table.itemlist`.
    const picked = pickUnique(q('.subtext'), document);
    expect(picked.value.startsWith('table.itemlist >')).toBe(true);
    expect(positionalDepth(picked.value)).toBeLessThanOrEqual(4);
    expect(picked.fragile).toBe(true); // still positional — say so
  });

  it('never reports a positional selector as non-fragile', () => {
    // The honesty invariant. Fragility is what a Ship reviewer reads to know whether an edit can
    // be mapped back to source; a value carrying an nth-of-type step never can be.
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const picked = pickUnique(el, document);
      if (positionalDepth(picked.value) > 0) {
        expect([picked.value, picked.fragile]).toEqual([picked.value, true]);
      }
    }
  });

  it('still resolves every emitted selector back to exactly its own element', () => {
    // The non-negotiable invariant the new candidate rungs must not break: `queryOne` takes
    // hits[0], so an ambiguous value silently mutates a DIFFERENT element while the user watches.
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const picked = pickUnique(el, document);
      const hits = document.querySelectorAll(picked.value);
      expect([picked.value, hits.length, hits[0] === el]).toEqual([picked.value, 1, true]);
    }
  });
});

describe('isVolatileId', () => {
  it('treats a long digit run as a record key, wherever it sits in the id', () => {
    for (const id of ['49299222', 'up_49299222', 'score_49299222', 'product-123456', 'row_2024']) {
      expect([id, isVolatileId(id)]).toEqual([id, true]);
    }
  });

  it('leaves ordinary structural numbering alone', () => {
    for (const id of ['col-2', 'step-3', 'h1', 'main-nav', 'sidebar_2']) {
      expect([id, isVolatileId(id)]).toEqual([id, false]);
    }
  });
});
