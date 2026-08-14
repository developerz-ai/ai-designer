import { beforeEach, describe, expect, it } from 'vitest';
import { createDomExecutor } from '@/dom/execute';
import { createMutator, SHEET_ATTR } from '@/dom/mutate';
import { createRecorder } from '@/dom/recorder';
import type { StylesheetEdit } from '@/shared/changeset';
import type { ContentToSw, MutationEvent } from '@/shared/messages';

// The content-side wiring of the six DomTool members added for the overhaul slice. The executor is
// the seam where a bus message becomes a reversible page change AND a truthful changeset entry, and
// the thing most worth asserting is that second half: every one of these is recorded as the kind it
// actually is, with the structural delta that actually describes it.

function harness() {
  const events: MutationEvent[] = [];
  const sheets: StylesheetEdit[] = [];
  const emit = (msg: ContentToSw): void => {
    if (msg.type === 'recorder-event') events.push(msg.event);
    if (msg.type === 'stylesheet-recorded') sheets.push(msg.sheet);
  };
  const mutator = createMutator(document);
  const recorder = createRecorder(emit, () => 1_000);
  return { exec: createDomExecutor({ mutator, recorder, emit, doc: document }), events, sheets };
}

describe('wrapNode through the executor', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><p id="a">A</p><p id="b">B</p><p id="c">C</p></main>';
  });

  it('records the WRAP kind, never an insert', () => {
    // A wrapNode recorded as an insertNode would undo by deleting the wrapper and orphaning
    // everything it wrapped. The kind is the inverse, so it has to be its own.
    const h = harness();
    const res = h.exec.exec({
      type: 'wrapNode',
      selector: '#a',
      html: '<section class="intro"></section>',
      intent: 'Give the intro its own landmark',
    });

    expect(res.ok).toBe(true);
    expect(h.events[0]?.kind).toBe('wrapNode');
    expect(h.events[0]?.structural).toEqual({ op: 'wrap', html: '<section class="intro">' });
    expect(h.events[0]?.intent).toBe('Give the intro its own landmark');
  });

  it('records the RANGE end so the brief says which siblings moved', () => {
    const h = harness();
    h.exec.exec({
      type: 'wrapNode',
      selector: '#a',
      endSelector: '#c',
      html: '<section></section>',
    });

    const structural = h.events[0]?.structural;
    expect(structural?.op).toBe('wrap');
    expect(structural?.op === 'wrap' && structural.endSelector?.value).toBe('#c');
    expect(document.querySelectorAll('main > section > p')).toHaveLength(3);
  });

  it('names the target by where the agent FOUND it, not where the wrap put it', () => {
    // The selector is taken before the wrap; afterwards the element sits a level deeper, and a path
    // describing the post-wrap position is a path to markup that does not exist in source.
    const h = harness();
    h.exec.exec({ type: 'wrapNode', selector: '#a', html: '<section></section>' });
    expect(h.events[0]?.selector.value).toBe('#a');
  });

  it('guards BOTH ends of a range', () => {
    // A range whose END is <body> absorbs the page just as surely as one whose start is.
    document.body.innerHTML = '<p id="a">A</p>';
    const h = harness();
    const res = h.exec.exec({
      type: 'wrapNode',
      selector: '#a',
      endSelector: 'body',
      html: '<section></section>',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blank the page/i);
  });

  it('turns a malformed wrapper into a clean refusal, never a crash', () => {
    const h = harness();
    const res = h.exec.exec({ type: 'wrapNode', selector: '#a', html: '<div></div><div></div>' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exactly one/i);
    expect(h.events).toHaveLength(0); // nothing recorded for a change that never happened
  });

  it('puts the wrapped nodes in the wrapper deepest single element', () => {
    const h = harness();
    h.exec.exec({
      type: 'wrapNode',
      selector: '#a',
      endSelector: '#c',
      html: '<section class="stories"><ul></ul></section>',
    });
    // `<section><ul></ul></section>` means "put them in the <ul>" — descending to the deepest
    // unambiguous slot is what makes that markup mean what its author wrote.
    expect(document.querySelectorAll('section.stories > ul > p')).toHaveLength(3);
  });
});

describe('unwrapNode and replaceNode through the executor', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<main><center id="legacy"><p>1</p></center><table id="t"><tbody></tbody></table></main>';
  });

  it('records unwrap with the wrapper markup that was removed', () => {
    const h = harness();
    h.exec.exec({ type: 'unwrapNode', selector: '#legacy', intent: 'Drop the legacy centering' });
    expect(h.events[0]?.kind).toBe('unwrapNode');
    expect(h.events[0]?.structural).toEqual({ op: 'unwrap', html: '<center id="legacy">' });
    expect(document.querySelector('center')).toBeNull();
  });

  it('records replace as a DELTA — what it became and what it was', () => {
    const h = harness();
    h.exec.exec({
      type: 'replaceNode',
      selector: '#t',
      html: '<section class="stories"><ul></ul></section>',
      intent: 'Replace the table layout with semantic markup',
    });
    const structural = h.events[0]?.structural;
    expect(structural?.op).toBe('replace');
    expect(structural?.op === 'replace' && structural.html).toContain('<section class="stories">');
    // Without `replacedHtml` this is a one-way write and a reviewer cannot see what was lost.
    expect(structural?.op === 'replace' && structural.replacedHtml).toContain('<table');
  });

  it('refuses to blank the page', () => {
    const h = harness();
    for (const res of [
      h.exec.exec({ type: 'unwrapNode', selector: 'body' }),
      h.exec.exec({ type: 'replaceNode', selector: 'html', html: '<p>x</p>' }),
    ]) {
      expect(res.ok).toBe(false);
    }
  });
});

describe('removeAttr through the executor', () => {
  beforeEach(() => {
    document.body.innerHTML = '<table id="t" width="85%"><tbody></tbody></table>';
  });

  it('records the null-after attribute delta', () => {
    const h = harness();
    const res = h.exec.exec({
      type: 'removeAttr',
      selector: '#t',
      name: 'width',
      intent: 'Drop the presentational width',
    });
    expect(res.ok).toBe(true);
    expect(h.events[0]?.kind).toBe('setAttr');
    expect(h.events[0]?.attrChange).toEqual({ name: 'width', before: '85%', after: null });
  });

  it('still refuses the editor own marker', () => {
    const h = harness();
    const res = h.exec.exec({ type: 'removeAttr', selector: '#t', name: 'data-dz-designer' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/reserved/i);
  });
});

describe('injectCss through the executor', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '<main></main>';
  });

  it('emits stylesheet-recorded, NOT a recorder event', () => {
    // A page-level sheet has no element target, so it cannot ride the recorder's MutationEvent
    // path — which requires a selector. It is also the single most shippable thing a session
    // produces, so it must reach the changeset by its own route.
    const h = harness();
    const res = h.exec.exec({
      type: 'injectCss',
      css: ':root { --accent: #6366f1 }',
      id: 'tokens',
      intent: 'Establish a token layer',
    });

    expect(res.ok).toBe(true);
    expect(h.events).toHaveLength(0);
    expect(h.sheets).toEqual([
      { id: 'tokens', css: ':root { --accent: #6366f1 }', intent: 'Establish a token layer' },
    ]);
  });

  it('reports whether it REPLACED a sheet, so refining reads differently from adding', () => {
    const h = harness();
    const first = h.exec.exec({ type: 'injectCss', css: 'main { color: red }', id: 'x' });
    const second = h.exec.exec({ type: 'injectCss', css: 'main { color: blue }', id: 'x' });
    expect(first.data).toMatchObject({ replaced: false });
    expect(second.data).toMatchObject({ replaced: true });
    expect(document.querySelectorAll(`style[${SHEET_ATTR}]`)).toHaveLength(1);
  });

  it('turns a policy refusal into a readable error, never a throw', () => {
    const h = harness();
    const res = h.exec.exec({ type: 'injectCss', css: '@import url(https://x/y.css);', id: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/@import/);
    expect(h.sheets).toHaveLength(0); // nothing recorded for a sheet that never landed
  });
});
