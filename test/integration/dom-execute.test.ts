import { describe, expect, it } from 'vitest';
import { createDomExecutor, type DomExecutor } from '@/dom/execute';
import { createMutator, MARKER_ATTR } from '@/dom/mutate';
import { createRecorder } from '@/dom/recorder';
import {
  type ContentToSw,
  InsertNodeInput,
  type QueryResult,
  type ToolResult,
} from '@/shared/messages';

// Integration: a validated DomTool routed through the real executor + mutator + recorder against a
// live jsdom DOM, asserting the ToolResult shape and that mutations record + reverse. This is the
// content script's dispatch path minus the chrome bus (screenshot's async SW round-trip is the
// only piece the entrypoint owns and is covered by the loaded-extension e2e).

function setup(html: string): { exec: DomExecutor['exec']; emitted: ContentToSw[] } {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
  const emitted: ContentToSw[] = [];
  const recorder = createRecorder(
    (m) => emitted.push(m),
    () => 0,
  );
  const executor = createDomExecutor({ mutator: createMutator(document), recorder, doc: document });
  return { exec: executor.exec, emitted };
}

const data = <T>(r: ToolResult): T => r.data as T;

describe('DomTool execute — reads', () => {
  it('query returns a stable selector per match and never errors', () => {
    const { exec } = setup('<button data-testid="cta">Buy</button>');
    const result = exec({ type: 'query', selector: 'button' });
    expect(result.ok).toBe(true);
    expect(data<QueryResult>(result).matches[0]).toMatchObject({
      value: '[data-testid="cta"]',
      strategy: 'data-attr',
    });
  });

  it('getStyles projects the computed subset and echoes the resilient selector', () => {
    const { exec } = setup('<p id="p" style="display: flex">x</p>');
    const result = exec({ type: 'getStyles', selector: '#p' });
    expect(result.ok).toBe(true);
    expect(result.selector?.value).toBe('#p');
    expect(data<{ styles: Record<string, string> }>(result).styles.display).toBe('flex');
  });

  it('a11ySnapshot returns the role/name tree', () => {
    const { exec } = setup('<nav id="n"><a href="/">Home</a></nav>');
    const result = exec({ type: 'a11ySnapshot', selector: '#n' });
    expect(data<{ tree: { role: string } }>(result).tree.role).toBe('navigation');
  });

  it('an unmatched selector is an error ToolResult, not a throw', () => {
    const { exec } = setup('<div></div>');
    const result = exec({ type: 'getStyles', selector: '#ghost' });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('#ghost');
  });
});

describe('DomTool execute — mutations record + reverse', () => {
  it('setStyle mutates via the injected sheet, records an event, and reports computed + selector', () => {
    const { exec, emitted } = setup('<button id="cta">Buy</button>');
    const result = exec({ type: 'setStyle', selector: '#cta', props: { color: 'rgb(1, 2, 3)' } });

    expect(result.ok).toBe(true);
    expect(result.selector?.value).toBe('#cta');
    expect(data<Record<string, string>>(result).color).toBe('rgb(1, 2, 3)');
    // recorded on the bus…
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'recorder-event', event: { kind: 'setStyle' } });
    // …and applied through the overrides stylesheet, never inline.
    expect(document.getElementById('cta')?.getAttribute('style')).toBeNull();
    expect(document.getElementById('dz-designer-overrides')?.textContent).toContain('color');
  });

  it('setText replaces text and records it', () => {
    const { exec, emitted } = setup('<p id="t">before</p>');
    exec({ type: 'setText', selector: '#t', value: 'after' });
    expect(document.getElementById('t')?.textContent).toBe('after');
    expect(emitted[0]).toMatchObject({ type: 'recorder-event', event: { kind: 'setText' } });
  });

  it('undo reverses the last mutation and reports it; a second undo is a benign no-op', () => {
    const { exec } = setup('<p id="t">before</p>');
    exec({ type: 'setText', selector: '#t', value: 'after' });

    const undone = exec({ type: 'undo' });
    expect(undone.ok).toBe(true);
    expect(data<{ kind: string }>(undone).kind).toBe('setText');
    expect(document.getElementById('t')?.textContent).toBe('before');

    // #5: an empty undo log is a no-op (ok), not an error the agent must reason about.
    const empty = exec({ type: 'undo' });
    expect(empty).toMatchObject({ ok: true, data: { undone: false } });
  });

  it('setAttr applies a safe attribute and records it', () => {
    const { exec, emitted } = setup('<a id="l">x</a>');
    const result = exec({ type: 'setAttr', selector: '#l', name: 'href', value: '/home' });
    expect(result.ok).toBe(true);
    expect(document.getElementById('l')?.getAttribute('href')).toBe('/home');
    expect(emitted[0]).toMatchObject({ type: 'recorder-event', event: { kind: 'setAttr' } });
  });

  it('setAttr refuses on* / src / javascript: without touching the DOM or recording', () => {
    const { exec, emitted } = setup('<a id="l">x</a>');
    const denied = [
      { name: 'onclick', value: 'steal()' },
      { name: 'src', value: 'https://cdn/x.js' },
      { name: 'srcdoc', value: '<script>x()</script>' },
      { name: 'href', value: 'javascript:alert(1)' },
    ] as const;
    for (const { name, value } of denied) {
      const r = exec({ type: 'setAttr', selector: '#l', name, value });
      expect(r.ok, `${name}=${value}`).toBe(false);
    }
    const el = document.getElementById('l');
    expect(el?.hasAttribute('onclick')).toBe(false);
    expect(el?.hasAttribute('src')).toBe(false);
    expect(el?.hasAttribute('srcdoc')).toBe(false);
    expect(el?.getAttribute('href')).toBeNull();
    expect(emitted).toHaveLength(0); // a refusal is not a mutation
  });

  it('refuses a DOM-invalid class/attr token with a clean error instead of throwing', () => {
    const { exec, emitted } = setup('<div id="d"></div>');
    // classList.add throws on an empty or whitespace-bearing token; setAttribute on an invalid name.
    // The executor must catch these and answer with an error ToolResult, never let the throw escape.
    expect(exec({ type: 'addClass', selector: '#d', name: 'btn primary' })).toMatchObject({
      ok: false,
    });
    expect(exec({ type: 'addClass', selector: '#d', name: '' })).toMatchObject({ ok: false });
    expect(exec({ type: 'setAttr', selector: '#d', name: 'foo bar', value: 'x' })).toMatchObject({
      ok: false,
    });
    expect(document.getElementById('d')?.classList.length).toBe(0); // nothing partially applied
    expect(emitted).toHaveLength(0);
  });

  it('addClass and removeClass toggle a class and record each', () => {
    const { exec, emitted } = setup('<div id="d" class="a"></div>');
    exec({ type: 'addClass', selector: '#d', name: 'hero' });
    expect(document.getElementById('d')?.classList.contains('hero')).toBe(true);
    exec({ type: 'removeClass', selector: '#d', name: 'a' });
    expect(document.getElementById('d')?.classList.contains('a')).toBe(false);
    expect(emitted[0]).toMatchObject({ type: 'recorder-event', event: { kind: 'addClass' } });
    expect(emitted[1]).toMatchObject({ type: 'recorder-event', event: { kind: 'removeClass' } });
  });

  it('setText refuses an element with child elements (leaf-guard) and records nothing', () => {
    const { exec, emitted } = setup('<p id="t">Hi <b>bold</b></p>');
    const r = exec({ type: 'setText', selector: '#t', value: 'flat' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('child');
    expect(document.getElementById('t')?.querySelector('b')).not.toBeNull(); // subtree intact
    expect(emitted).toHaveLength(0);
  });

  it('undo of a setStyle drops the rule and the marker', () => {
    const { exec } = setup('<button id="cta">Buy</button>');
    exec({ type: 'setStyle', selector: '#cta', props: { color: 'red' } });
    exec({ type: 'undo' });
    expect(document.getElementById('cta')?.hasAttribute(MARKER_ATTR)).toBe(false);
    expect(document.getElementById('dz-designer-overrides')?.textContent).toBe('');
  });
});

describe('DomTool execute — structural mutations (#58)', () => {
  it('insertNode inserts markup relative to a reference and records it', () => {
    const { exec, emitted } = setup('<ul id="list"><li id="a">a</li></ul>');
    const result = exec({
      type: 'insertNode',
      selector: '#list',
      html: '<li id="b">b</li>',
      position: 'beforeend',
    });

    expect(result.ok).toBe(true);
    expect(document.getElementById('b')).not.toBeNull();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'recorder-event', event: { kind: 'insertNode' } });
  });

  it('the insertNode input schema defaults position to beforeend through the real bus parse', () => {
    const { exec } = setup('<ul id="list"></ul>');
    // The content listener safe-parses inbound DomTool messages; drive exec through the same
    // parse so the default materializes exactly as in production.
    const parsed = InsertNodeInput.parse({
      type: 'insertNode',
      selector: '#list',
      html: '<li id="d" />',
    });
    const result = exec(parsed);

    expect(result.ok).toBe(true);
    expect(document.getElementById('list')?.lastElementChild?.id).toBe('d');
  });

  it('moveNode moves an element relative to a reference and records it', () => {
    const { exec, emitted } = setup('<div id="a"><span id="s">x</span></div><div id="b"></div>');
    const result = exec({
      type: 'moveNode',
      selector: '#s',
      refSelector: '#b',
      position: 'beforeend',
    });

    expect(result.ok).toBe(true);
    expect(document.getElementById('b')?.contains(document.getElementById('s'))).toBe(true);
    expect(emitted[0]).toMatchObject({ type: 'recorder-event', event: { kind: 'moveNode' } });
  });

  it('moveNode reports notFound for an unmatched target OR anchor, naming the missing one', () => {
    const { exec } = setup('<div id="a"></div>');

    expect(
      exec({ type: 'moveNode', selector: '#ghost', refSelector: '#a', position: 'beforeend' }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('#ghost') });
    expect(
      exec({ type: 'moveNode', selector: '#a', refSelector: '#ghost', position: 'beforeend' }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('#ghost') });
  });

  it('removeNode removes and records; undo re-inserts the SAME node object at its anchor', () => {
    const { exec } = setup('<ul id="list"><li id="x">x</li><li id="y">y</li></ul>');
    const x = document.getElementById('x');

    exec({ type: 'removeNode', selector: '#x' });
    expect(document.getElementById('x')).toBeNull();

    exec({ type: 'undo' });
    // Node IDENTITY (not an equal clone — listeners/state survive), back at the original anchor.
    expect(document.getElementById('x')).toBe(x);
    expect(
      Array.from(document.getElementById('list')?.querySelectorAll('li') ?? []).map((li) => li.id),
    ).toEqual(['x', 'y']);
  });

  it('undo of a moveNode restores the original parent + nextSibling (a same-tag sibling defeats an index restore)', () => {
    const { exec } = setup(
      '<div id="a"><span id="one">1</span><span id="two">2</span></div><div id="b"></div>',
    );
    const [one, two] = [document.getElementById('one'), document.getElementById('two')];

    exec({ type: 'moveNode', selector: '#one', refSelector: '#b', position: 'beforeend' });
    expect(document.getElementById('b')?.contains(one ?? null)).toBe(true);

    exec({ type: 'undo' });
    expect(document.getElementById('a')?.contains(one ?? null)).toBe(true);
    expect(one?.nextSibling).toBe(two); // the anchor, not "index 0"
  });

  it('undo is LIFO across a mix of property and structural mutations', () => {
    const { exec } = setup('<p id="t">x</p><ul id="l"></ul>');

    exec({ type: 'setText', selector: '#t', value: 'y' });
    exec({ type: 'insertNode', selector: '#l', html: '<li id="i">i</li>', position: 'beforeend' });

    exec({ type: 'undo' }); // pops the INSERT first (most recent)
    expect(document.getElementById('i')).toBeNull();
    expect(document.getElementById('t')?.textContent).toBe('y');

    exec({ type: 'undo' }); // then the setText
    expect(document.getElementById('t')?.textContent).toBe('x');

    expect(exec({ type: 'undo' })).toMatchObject({ ok: true, data: { undone: false } });
  });
});

describe('DomTool execute — structural guards + churn honesty (#58 review)', () => {
  it('refuses to move an element into its own descendant (HierarchyRequestError → clean refusal)', () => {
    const { exec, emitted } = setup('<div id="a"><span id="child">x</span></div>');

    const result = exec({
      type: 'moveNode',
      selector: '#a',
      refSelector: '#child',
      position: 'beforeend',
    });

    expect(result.ok).toBe(false);
    expect(emitted).toHaveLength(0); // nothing recorded — the page is untouched
    expect(document.getElementById('a')?.contains(document.getElementById('child'))).toBe(true);
  });

  it('refuses structural ops on <body> as the mutated element, but allows body as a destination', () => {
    const { exec } = setup('<div id="d">x</div>');

    expect(exec({ type: 'removeNode', selector: 'body' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('<body>'),
    });
    expect(
      exec({ type: 'moveNode', selector: 'body', refSelector: '#d', position: 'beforeend' }),
    ).toMatchObject({ ok: false });
    // …but inserting INTO body (a banner at page bottom) is a normal design action:
    expect(
      exec({
        type: 'insertNode',
        selector: 'body',
        html: '<footer id="f">x</footer>',
        position: 'beforeend',
      }),
    ).toMatchObject({ ok: true });
    expect(document.getElementById('f')).not.toBeNull();
  });

  it('refuses to insert into or remove the editor’s own overrides sheet', () => {
    const { exec } = setup('<div></div>');
    // The sheet only exists after a setStyle; create it.
    exec({ type: 'setStyle', selector: 'body', props: { color: 'red' } });
    expect(document.getElementById('dz-designer-overrides')).not.toBeNull();

    expect(exec({ type: 'removeNode', selector: '#dz-designer-overrides' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('overrides'),
    });
    expect(
      exec({
        type: 'insertNode',
        selector: '#dz-designer-overrides',
        html: '<span>x</span>',
        position: 'beforeend',
      }),
    ).toMatchObject({ ok: false });
    expect(document.getElementById('dz-designer-overrides')).not.toBeNull();
  });

  it('removeNode records the PRE-REMOVAL stable selector, not a degraded bare tag', () => {
    const { exec, emitted } = setup('<ul id="list"><li id="x">x</li><li id="y">y</li></ul>');

    exec({ type: 'removeNode', selector: '#x' });

    const event = (emitted[0] as { event?: { selector?: { value: string } } }).event;
    expect(event?.selector?.value).toBe('#x'); // the pre-removal identity, recorded explicitly
  });

  it('a churned anchor turns undo into an honest refusal — and keeps the log entry for a later success', () => {
    const { exec } = setup('<ul id="list"><li id="x">x</li><li id="y">y</li></ul>');
    const y = document.getElementById('y');

    exec({ type: 'removeNode', selector: '#x' });
    y?.remove(); // page-side churn the recorder knows nothing about

    const failed = exec({ type: 'undo' });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('original location changed');
    expect(document.getElementById('x')).toBeNull(); // no fake revert happened

    // The entry was NOT lost: put the anchor back (page churns again) and the same undo succeeds.
    document.getElementById('list')?.appendChild(y as Node);
    expect(exec({ type: 'undo' })).toMatchObject({ ok: true });
    expect(document.getElementById('x')).not.toBeNull();
  });

  it('undo of a moveNode restores the anchor after a concurrent shift (an index restore would fail)', () => {
    const { exec } = setup(
      '<div id="a"><span id="one">1</span><span id="two">2</span></div><div id="b"></div>',
    );
    const [one, two, a] = [
      document.getElementById('one'),
      document.getElementById('two'),
      document.getElementById('a'),
    ];

    exec({ type: 'moveNode', selector: '#one', refSelector: '#b', position: 'beforeend' });
    // Unrecorded concurrent shift: a NEW first child lands in the original parent.
    a?.insertBefore(document.createElement('span'), two ?? null);

    exec({ type: 'undo' });
    expect(a?.contains(one ?? null)).toBe(true);
    expect(one?.nextSibling).toBe(two); // before the ORIGINAL sibling, not before the new node
  });
});
