import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractor } from '@/dom/interact';
import type { ToolResult } from '@/shared/messages';

// Unit (jsdom): the interaction engine drives a live DOM through realistic event sequences. jsdom
// stubs scrollIntoView / scrollTo (they'd otherwise log "not implemented"); we mock them to
// no-ops and, where relevant, assert they were called.

const interactor = createInteractor();
const data = <T>(r: ToolResult): T => r.data as T;

function mount(html: string): void {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
}

beforeEach(() => {
  // jsdom implements neither scrollIntoView nor scrollTo; install spies so the engine's guarded
  // calls run (and are assertable) instead of logging "not implemented".
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('click', () => {
  it('fires a real click (default action + framework pointer/mouse sequence) and echoes a selector', async () => {
    mount('<button id="cta">Buy</button>');
    const seq: string[] = [];
    const btn = document.getElementById('cta') as HTMLButtonElement;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      btn.addEventListener(type, () => seq.push(type));
    }

    const result = await interactor.run({ type: 'click', selector: '#cta' });

    expect(result.ok).toBe(true);
    expect(result.selector?.value).toBe('#cta');
    expect(seq).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    expect(btn.scrollIntoView).toHaveBeenCalled();
  });

  it('performs the element default action (toggles a checkbox)', async () => {
    mount('<input id="c" type="checkbox" />');
    await interactor.run({ type: 'click', selector: '#c' });
    expect((document.getElementById('c') as HTMLInputElement).checked).toBe(true);
  });

  it('is an error ToolResult for an unmatched selector', async () => {
    mount('<div></div>');
    const result = await interactor.run({ type: 'click', selector: '#ghost' });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('#ghost');
  });
});

describe('type', () => {
  it('sets the value via the native setter and fires input + change', async () => {
    mount('<input id="q" />');
    const el = document.getElementById('q') as HTMLInputElement;
    let inputs = 0;
    let changes = 0;
    el.addEventListener('input', () => (inputs += 1));
    el.addEventListener('change', () => (changes += 1));

    const result = await interactor.run({ type: 'type', selector: '#q', text: 'hello' });

    expect(el.value).toBe('hello');
    expect(inputs).toBe(1);
    expect(changes).toBe(1);
    expect(data<{ value: string }>(result).value).toBe('hello');
  });

  it('submits the owning form on submit:true (respecting a prevented Enter keydown)', async () => {
    mount('<form id="f"><input id="q" /></form>');
    const form = document.getElementById('f') as HTMLFormElement;
    let submitted = 0;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitted += 1;
    });

    await interactor.run({ type: 'type', selector: '#q', text: 'go', submit: true });
    expect(submitted).toBe(1);
  });

  it('types into a contenteditable host', async () => {
    mount('<div id="e" contenteditable="true"></div>');
    await interactor.run({ type: 'type', selector: '#e', text: 'rich' });
    expect(document.getElementById('e')?.textContent).toBe('rich');
  });

  it('errors on a non-editable element', async () => {
    mount('<div id="d">x</div>');
    const result = await interactor.run({ type: 'type', selector: '#d', text: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a text field');
  });
});

describe('pressKey', () => {
  it('dispatches keydown/keyup carrying the key on the active element', async () => {
    mount('<input id="q" />');
    const el = document.getElementById('q') as HTMLInputElement;
    el.focus();
    const keys: string[] = [];
    el.addEventListener('keydown', (e) => keys.push(`down:${e.key}`));
    el.addEventListener('keyup', (e) => keys.push(`up:${e.key}`));

    const result = await interactor.run({ type: 'pressKey', key: 'Enter' });

    expect(result.ok).toBe(true);
    expect(keys).toEqual(['down:Enter', 'up:Enter']);
  });
});

describe('hover', () => {
  it('fires mouseover/mouseenter/mousemove to reveal hover UI', async () => {
    mount('<div id="menu">m</div>');
    const el = document.getElementById('menu') as HTMLElement;
    const seen: string[] = [];
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
      el.addEventListener(type, () => seen.push(type));
    }

    const result = await interactor.run({ type: 'hover', selector: '#menu' });

    expect(result.ok).toBe(true);
    expect(seen).toEqual(['mouseover', 'mouseenter', 'mousemove']);
  });
});

describe('scrollTo', () => {
  it('scrolls an element into view and reports the scroll position', async () => {
    mount('<div id="target">t</div>');
    const el = document.getElementById('target') as HTMLElement;
    const result = await interactor.run({ type: 'scrollTo', selector: '#target' });
    expect(el.scrollIntoView).toHaveBeenCalled();
    expect(data<{ x: number; y: number }>(result)).toMatchObject({ x: 0, y: 0 });
  });

  it('scrolls to an absolute y offset', async () => {
    mount('<div>x</div>');
    await interactor.run({ type: 'scrollTo', y: 400 });
    expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 400 }));
  });
});

describe('selectOption', () => {
  it('picks a native <select> option by value and fires change', async () => {
    mount('<select id="s"><option value="a">A</option><option value="b">B</option></select>');
    const el = document.getElementById('s') as HTMLSelectElement;
    let changed = 0;
    el.addEventListener('change', () => (changed += 1));

    const result = await interactor.run({ type: 'selectOption', selector: '#s', value: 'b' });

    expect(el.value).toBe('b');
    expect(changed).toBe(1);
    expect(data<{ value: string }>(result).value).toBe('b');
  });

  it('falls back to matching the visible option label', async () => {
    mount(
      '<select id="s"><option value="a">Apple</option><option value="b">Pear</option></select>',
    );
    await interactor.run({ type: 'selectOption', selector: '#s', value: 'Pear' });
    expect((document.getElementById('s') as HTMLSelectElement).value).toBe('b');
  });

  it('selects an ARIA listbox option by its text and marks aria-selected', async () => {
    mount(
      '<ul id="lb" role="listbox">' + '<li role="option">One</li><li role="option">Two</li></ul>',
    );
    const result = await interactor.run({ type: 'selectOption', selector: '#lb', value: 'Two' });
    const options = document.querySelectorAll('#lb [role="option"]');
    expect(result.ok).toBe(true);
    expect(options[0]?.getAttribute('aria-selected')).toBe('false');
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('errors when no option matches', async () => {
    mount('<select id="s"><option value="a">A</option></select>');
    const result = await interactor.run({ type: 'selectOption', selector: '#s', value: 'z' });
    expect(result.ok).toBe(false);
  });
});

describe('waitFor', () => {
  it('resolves met:true as soon as the selector appears (MutationObserver)', async () => {
    mount('<div id="root"></div>');
    const pending = interactor.run({ type: 'waitFor', selector: '#late', timeMs: 1000 });

    const el = document.createElement('span');
    el.id = 'late';
    document.getElementById('root')?.appendChild(el);

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(data<{ met: boolean }>(result).met).toBe(true);
  });

  it('resolves met:true when awaited text appears', async () => {
    mount('<div id="root"></div>');
    const pending = interactor.run({ type: 'waitFor', text: 'ready', timeMs: 1000 });
    const root = document.getElementById('root');
    if (root) root.textContent = 'now ready';
    const result = await pending;
    expect(data<{ met: boolean }>(result).met).toBe(true);
  });

  it('resolves met:false on timeout when the condition never holds', async () => {
    mount('<div></div>');
    const result = await interactor.run({ type: 'waitFor', selector: '#never', timeMs: 20 });
    expect(result.ok).toBe(true);
    const payload = data<{ met: boolean; timedOut: boolean }>(result);
    expect(payload.met).toBe(false);
    expect(payload.timedOut).toBe(true);
  });

  it('treats a bare timeMs as a bounded delay (met:true)', async () => {
    mount('<div></div>');
    const result = await interactor.run({ type: 'waitFor', timeMs: 15 });
    expect(data<{ met: boolean }>(result).met).toBe(true);
  });
});

describe('handleDialog', () => {
  afterEach(() => {
    // handleDialog reassigns window.confirm/alert/prompt; restore between cases.
    vi.restoreAllMocks();
  });

  it('arms confirm/prompt to auto-accept', async () => {
    const result = await interactor.run({
      type: 'handleDialog',
      accept: true,
      promptText: 'yes',
    });
    expect(result.ok).toBe(true);
    expect(window.confirm('sure?')).toBe(true);
    expect(window.prompt('name?')).toBe('yes');
  });

  it('arms confirm to auto-dismiss and prompt to null', async () => {
    await interactor.run({ type: 'handleDialog', accept: false });
    expect(window.confirm('sure?')).toBe(false);
    expect(window.prompt('name?')).toBeNull();
  });
});
