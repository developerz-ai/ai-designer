import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPicker, PICKER_HOST_ID, type Picker } from '@/dom/picker';
import type { ContentToSw } from '@/shared/messages';

// Picker unit tests (jsdom). The picker is pure DOM + an injected `emit`, so we drive it with
// synthetic mouse/keyboard events and assert both the emitted ContentToSw events and the
// shadow-DOM chrome. getBoundingClientRect is 0×0 under jsdom — positions aren't asserted.
// Every spawned picker is destroyed in afterEach: it adds capture-phase listeners to `document`,
// and a leaked one would preempt the next test's picker via stopImmediatePropagation.

const alive: Picker[] = [];

function spawn(): { picker: Picker; msgs: ContentToSw[] } {
  const msgs: ContentToSw[] = [];
  const picker = createPicker((m) => msgs.push(m), document);
  alive.push(picker);
  return { picker, msgs };
}

function shadow(): ShadowRoot {
  const host = document.getElementById(PICKER_HOST_ID);
  if (!host?.shadowRoot) throw new Error('picker host not mounted');
  return host.shadowRoot;
}

function byId(id: string): Element {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fixture missing: #${id}`);
  return el;
}

function over(el: Element): void {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}

function click(el: Element, opts: MouseEventInit = {}): MouseEvent {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...opts });
  el.dispatchEvent(e);
  return e;
}

const byType = (msgs: ContentToSw[], type: ContentToSw['type']): ContentToSw[] =>
  msgs.filter((m) => m.type === type);

const values = (msgs: ContentToSw[]): string[][] =>
  byType(msgs, 'multi-select-changed').map((m) =>
    m.type === 'multi-select-changed' ? m.selectors.map((s) => s.value) : [],
  );

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const p of alive.splice(0)) p.destroy();
});

describe('picker lifecycle', () => {
  it('start mounts the shadow host and emits picker-state active', () => {
    const { picker, msgs } = spawn();
    picker.start();

    expect(picker.isActive()).toBe(true);
    expect(document.getElementById(PICKER_HOST_ID)?.shadowRoot).not.toBeNull();
    expect(byType(msgs, 'picker-state')).toEqual([{ type: 'picker-state', active: true }]);
  });

  it('start is idempotent — a second call does not re-emit', () => {
    const { picker, msgs } = spawn();
    picker.start();
    picker.start();
    expect(byType(msgs, 'picker-state')).toHaveLength(1);
  });

  it('stop emits picker-state inactive and clears the overlay', () => {
    const { picker, msgs } = spawn();
    picker.start();
    picker.stop();

    expect(picker.isActive()).toBe(false);
    expect(msgs.at(-1)).toEqual({ type: 'picker-state', active: false });
    expect(shadow().querySelector('.dz-hover')?.classList.contains('dz-hidden')).toBe(true);
  });

  it('destroy removes the host from the DOM', () => {
    const { picker } = spawn();
    picker.start();
    picker.destroy();
    expect(document.getElementById(PICKER_HOST_ID)).toBeNull();
  });

  it('does nothing before start', () => {
    document.body.innerHTML = '<button id="b">x</button>';
    const { msgs } = spawn();
    over(byId('b'));
    click(byId('b'));
    expect(msgs).toHaveLength(0);
  });
});

describe('hover highlight + pill', () => {
  it('shows tag, dims and the resolved selector; no badge for a stable selector', () => {
    document.body.innerHTML = '<button id="b" data-testid="cta" class="btn primary">Buy</button>';
    const { picker } = spawn();
    picker.start();
    over(byId('b'));

    const root = shadow();
    expect(root.querySelector('.dz-hover')?.classList.contains('dz-hidden')).toBe(false);
    expect(root.querySelector('.dz-tag')?.textContent).toBe('button#b.btn');
    expect(root.querySelector('.dz-dims')?.textContent).toBe('0×0');
    expect(root.querySelector('.dz-sel')?.textContent).toBe('[data-testid="cta"]');
    expect(root.querySelector('.dz-badge')?.classList.contains('dz-hidden')).toBe(true);
  });

  it('shows the fragility badge for a brittle selector', () => {
    document.body.innerHTML = '<section id="s"><span></span><span></span></section>';
    const { picker } = spawn();
    picker.start();
    const span = document.querySelectorAll('#s span')[1];
    if (!span) throw new Error('fixture');
    over(span);

    expect(shadow().querySelector('.dz-badge')?.classList.contains('dz-hidden')).toBe(false);
  });
});

describe('selection', () => {
  it('click emits element-picked with candidates, rect and styles', () => {
    document.body.innerHTML = '<button id="b" data-testid="cta">Buy</button>';
    const { picker, msgs } = spawn();
    picker.start();
    const e = click(byId('b'));

    expect(e.defaultPrevented).toBe(true);
    const [picked] = byType(msgs, 'element-picked');
    if (picked?.type !== 'element-picked') throw new Error('no element-picked');
    expect(picked.candidates[0]).toMatchObject({
      value: '[data-testid="cta"]',
      strategy: 'data-attr',
    });
    expect(picked.rect).toMatchObject({ x: 0, y: 0, width: 0, height: 0 });
    expect(picked.styles).toBeTypeOf('object');
    // plain click keeps the picker active — the panel owns deactivation
    expect(picker.isActive()).toBe(true);
  });

  it('shift-click accumulates and toggles a multi-selection', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const { picker, msgs } = spawn();
    picker.start();

    click(byId('a'), { shiftKey: true });
    click(byId('b'), { shiftKey: true });
    click(byId('a'), { shiftKey: true }); // toggle a back off

    expect(values(msgs)).toEqual([['#a'], ['#a', '#b'], ['#b']]);
    // one persistent outline box remains (b)
    expect(shadow().querySelectorAll('.dz-box')).toHaveLength(1);
    expect(byType(msgs, 'element-picked')).toHaveLength(0);
  });

  it('a plain click resets a prior multi-selection', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const { picker, msgs } = spawn();
    picker.start();

    click(byId('a'), { shiftKey: true });
    click(byId('b')); // plain click clears multi, focuses b

    expect(msgs.at(-1)).toMatchObject({ type: 'element-picked' });
    expect(values(msgs).at(-1)).toEqual([]);
    expect(shadow().querySelectorAll('.dz-box')).toHaveLength(0);
  });

  it('ignores non-primary clicks', () => {
    document.body.innerHTML = '<button id="b">x</button>';
    const { picker, msgs } = spawn();
    picker.start();
    click(byId('b'), { button: 2 });
    expect(byType(msgs, 'element-picked')).toHaveLength(0);
  });
});

describe('keyboard', () => {
  it('Escape stops the picker', () => {
    const { picker, msgs } = spawn();
    picker.start();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(picker.isActive()).toBe(false);
    expect(msgs.at(-1)).toEqual({ type: 'picker-state', active: false });
  });

  it('stops tracking hover after stop', () => {
    document.body.innerHTML = '<button id="b" data-testid="cta">x</button>';
    const { picker } = spawn();
    picker.start();
    picker.stop();
    // listener removed → hover stays hidden
    over(byId('b'));
    expect(shadow().querySelector('.dz-hover')?.classList.contains('dz-hidden')).toBe(true);
  });
});
