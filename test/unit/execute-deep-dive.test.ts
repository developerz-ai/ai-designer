import { describe, expect, it } from 'vitest';
import { createDomExecutor, type DomExecutor } from '@/dom/execute';
import { createMutator, SHEET_ATTR } from '@/dom/mutate';
import { createRecorder } from '@/dom/recorder';
import { ContentToSw, type MutationEvent } from '@/shared/messages';

// Executor deep-dive regressions: injectCss on the shared undo stack, the CSS/load policy on
// content ops that reach a <style>/<link>/<base>/<script>, and the recorded selector being the
// PRE-mutation one.

function setup(html: string): { exec: DomExecutor['exec']; emitted: ContentToSw[] } {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
  const emitted: ContentToSw[] = [];
  const recorder = createRecorder(
    (m) => emitted.push(m),
    () => 0,
  );
  const executor = createDomExecutor({
    mutator: createMutator(document),
    recorder,
    doc: document,
    emit: (m) => emitted.push(m),
  });
  return { exec: executor.exec, emitted };
}

const sheet = (id = 'default') => document.querySelector(`style[${SHEET_ATTR}="${id}"]`);
const events = (emitted: ContentToSw[]): MutationEvent[] =>
  emitted.flatMap((m) => (m.type === 'recorder-event' ? [m.event] : []));

describe('injectCss is undoable on the shared stack', () => {
  it('undo after addClass + injectCss removes the sheet first, then the class', () => {
    const { exec, emitted } = setup('<p id="a">x</p>');
    exec({ type: 'addClass', selector: '#a', name: 'hot' });
    expect(exec({ type: 'injectCss', css: 'p{color:red}', id: 'default' }).ok).toBe(true);

    const first = exec({ type: 'undo' });
    expect(first).toMatchObject({ ok: true, data: { kind: 'injectCss', sheetId: 'default' } });
    expect(sheet()).toBeNull();
    expect(document.getElementById('a')?.classList.contains('hot')).toBe(true);
    // A page-level revert has no MutationEvent to retract.
    expect(emitted.filter((m) => m.type === 'recorder-revert')).toHaveLength(0);

    exec({ type: 'undo' });
    expect(document.getElementById('a')?.classList.contains('hot')).toBe(false);
  });

  it('undo of a re-injection restores the prior text under the normalized id', () => {
    const { exec } = setup('<p>x</p>');
    exec({ type: 'injectCss', css: 'p{color:red}', id: 'my theme' });
    exec({ type: 'injectCss', css: 'p{color:blue}', id: 'my theme' });
    expect(document.querySelectorAll(`style[${SHEET_ATTR}]`)).toHaveLength(1);
    expect(sheet('mytheme')?.textContent).toBe('p{color:blue}');

    exec({ type: 'undo' });
    expect(sheet('mytheme')?.textContent).toBe('p{color:red}');
    exec({ type: 'undo' });
    expect(sheet('mytheme')).toBeNull();
  });

  it('undo tells the SW what the stylesheet became: null when removed, prior text when replaced', () => {
    const { exec, emitted } = setup('<p>x</p>');
    exec({ type: 'injectCss', css: 'p{color:red}', id: 'my theme' });
    exec({ type: 'injectCss', css: 'p{color:blue}', id: 'my theme' });
    const reverted = () => emitted.filter((m) => m.type === 'stylesheet-reverted');

    const first = exec({ type: 'undo' });
    expect(reverted()).toEqual([
      { type: 'stylesheet-reverted', id: 'mytheme', css: 'p{color:red}' },
    ]);
    // The CSS text rides the bus, not the model's transcript.
    expect(first.data).toEqual({ kind: 'injectCss', sheetId: 'mytheme' });

    exec({ type: 'undo' });
    expect(reverted().at(-1)).toEqual({ type: 'stylesheet-reverted', id: 'mytheme', css: null });
    for (const msg of reverted()) expect(ContentToSw.safeParse(msg).success).toBe(true);
  });

  it('discardUndo of an injectCss emits no revert — the sheet is still live', () => {
    const { exec, emitted } = setup('<p id="a">x</p>');
    exec({ type: 'addClass', selector: '#a', name: 'hot' });
    exec({ type: 'injectCss', css: 'p{color:red}', id: 'default' });
    exec({ type: 'discardUndo' });
    expect(emitted.filter((m) => m.type === 'stylesheet-reverted')).toEqual([]);

    // The NEXT undo reaches the class edit beneath it; the discarded sheet stays live.
    exec({ type: 'undo' });
    expect(document.getElementById('a')?.classList.contains('hot')).toBe(false);
    expect(sheet()?.textContent).toBe('p{color:red}');
  });

  it('a refused injectCss stacks nothing', () => {
    const { exec } = setup('<p>x</p>');
    expect(
      exec({ type: 'injectCss', css: '@import url(https://evil.example/x.css);', id: 'default' })
        .ok,
    ).toBe(false);
    expect(exec({ type: 'undo' })).toMatchObject({ ok: true, data: { undone: false } });
  });

  it('discardUndo pops an injectCss entry without reverting it', () => {
    const { exec } = setup('<p id="a">x</p>');
    exec({ type: 'addClass', selector: '#a', name: 'hot' });
    exec({ type: 'injectCss', css: 'p{color:red}', id: 'default' });
    expect(exec({ type: 'discardUndo' })).toMatchObject({ data: { discarded: 'injectCss' } });
    expect(sheet()?.textContent).toBe('p{color:red}');

    expect(exec({ type: 'undo' })).toMatchObject({ ok: true, data: { kind: 'addClass' } });
    expect(document.getElementById('a')?.classList.contains('hot')).toBe(false);
    expect(sheet()?.textContent).toBe('p{color:red}');
  });
});

describe('content ops cannot side-door the CSS / load policy', () => {
  it('setText on a page <style> runs the injectCss policy', () => {
    const { exec } = setup('<style id="s">p{}</style><p>x</p>');
    const result = exec({
      type: 'setText',
      selector: '#s',
      value: '@import url(https://evil.example/x.css);',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/@import/);
    expect(document.getElementById('s')?.textContent).toBe('p{}');
  });

  it('setText on a page <style> with clean CSS still applies', () => {
    const { exec } = setup('<style id="s">p{}</style>');
    expect(exec({ type: 'setText', selector: '#s', value: 'p{color:red}' }).ok).toBe(true);
  });

  it('setText on a <script> is refused', () => {
    const { exec } = setup('<script id="j" type="text/plain"></script>');
    const result = exec({ type: 'setText', selector: '#j', value: 'alert(1)' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/script/);
  });

  it('setAttr href / rel on a <link> is refused', () => {
    const { exec } = setup('<link id="l" rel="stylesheet" href="/a.css"><link id="c" href="/x">');
    const href = exec({
      type: 'setAttr',
      selector: '#l',
      name: 'href',
      value: 'https://evil.example/x.css',
    });
    expect(href.ok).toBe(false);
    expect(document.getElementById('l')?.getAttribute('href')).toBe('/a.css');
    expect(exec({ type: 'setAttr', selector: '#c', name: 'rel', value: 'stylesheet' }).ok).toBe(
      false,
    );
  });

  it('setAttr href on <base> is refused; on <a> it is still fine', () => {
    const { exec } = setup('<base id="b" href="/"><a id="a" href="/x">x</a>');
    expect(exec({ type: 'setAttr', selector: '#b', name: 'href', value: 'https://e.x/' }).ok).toBe(
      false,
    );
    expect(exec({ type: 'setAttr', selector: '#a', name: 'href', value: '/y' }).ok).toBe(true);
  });

  it('an injectCss-created sheet is own chrome for content ops', () => {
    const { exec } = setup('<p>x</p>');
    exec({ type: 'injectCss', css: 'p{color:red}', id: 'theme' });
    const target = `style[${SHEET_ATTR}="theme"]`;
    const text = exec({ type: 'setText', selector: target, value: 'p{color:blue}' });
    expect(text.ok).toBe(false);
    expect(text.error).toMatch(/injectCss/);
    expect(exec({ type: 'removeNode', selector: target }).ok).toBe(false);
    expect(sheet('theme')?.textContent).toBe('p{color:red}');
  });
});

describe('recorded selector is the pre-mutation one', () => {
  it('setAttr adding data-testid records where the element WAS found', () => {
    const { exec, emitted } = setup('<main><button id="buy">Buy</button></main>');
    const result = exec({
      type: 'setAttr',
      selector: '#buy',
      name: 'data-testid',
      value: 'brand-new',
    });
    expect(events(emitted)[0]?.selector.value).toBe('#buy');
    // The selector handed back must still resolve on the page as it is now.
    expect(result.selector?.value).toBeDefined();
    expect(document.querySelectorAll(result.selector?.value ?? '')).toHaveLength(1);
  });

  it('a LATER edit of the same element keeps recording under its source selector', () => {
    const { exec, emitted } = setup('<main><button id="buy">Buy</button></main>');
    const first = exec({
      type: 'setAttr',
      selector: '#buy',
      name: 'data-testid',
      value: 'brand-new',
    });
    // The model keeps using the live selector it was handed back…
    exec({ type: 'addClass', selector: first.selector?.value ?? '', name: 'hot' });
    exec({ type: 'setStyle', selector: first.selector?.value ?? '', props: { color: 'red' } });

    // …but every edit of that element is recorded under the selector that exists in source.
    expect(events(emitted).map((e) => e.selector.value)).toEqual(['#buy', '#buy', '#buy']);
  });

  it('setAttr rewriting the keyed attribute hands back a selector that still resolves', () => {
    const { exec, emitted } = setup('<button data-testid="old">Buy</button>');
    const result = exec({
      type: 'setAttr',
      selector: '[data-testid="old"]',
      name: 'data-testid',
      value: 'new',
    });
    expect(events(emitted)[0]?.selector.value).toBe('[data-testid="old"]');
    expect(result.selector?.value).toBe('[data-testid="new"]');
  });
});
