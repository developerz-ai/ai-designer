import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPicker,
  isQuickPickChord,
  isQuickPickHoverChord,
  PICKER_HOST_ID,
  type Picker,
} from '@/dom/picker';
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

  it('drops the hover outline on reflow when the hovered target left the DOM', () => {
    document.body.innerHTML = '<button id="b" data-testid="cta">x</button>';
    const { picker } = spawn();
    picker.start();
    const btn = byId('b');
    over(btn);
    expect(shadow().querySelector('.dz-hover')?.classList.contains('dz-hidden')).toBe(false);

    btn.remove(); // target removed while still tracked
    document.dispatchEvent(new Event('scroll')); // reflow re-measures — must prune, not pin a 0×0 box

    expect(shadow().querySelector('.dz-hover')?.classList.contains('dz-hidden')).toBe(true);
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

  it('reflow prunes a disconnected multi-selected target and re-emits the selector set', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const { picker, msgs } = spawn();
    picker.start();

    click(byId('a'), { shiftKey: true });
    click(byId('b'), { shiftKey: true });
    const before = byType(msgs, 'multi-select-changed').length;

    byId('a').remove(); // a leaves the DOM while still selected
    document.dispatchEvent(new Event('scroll')); // reflow prunes a

    expect(byType(msgs, 'multi-select-changed')).toHaveLength(before + 1);
    expect(values(msgs).at(-1)).toEqual(['#b']);
    // stale outline is gone — only b's box remains
    expect(shadow().querySelectorAll('.dz-box')).toHaveLength(1);
  });

  it('reflow does not re-emit when the multi-selection is unchanged', () => {
    document.body.innerHTML = '<button id="a">A</button>';
    const { picker, msgs } = spawn();
    picker.start();

    click(byId('a'), { shiftKey: true });
    const before = byType(msgs, 'multi-select-changed').length;

    document.dispatchEvent(new Event('scroll')); // a still connected — nothing to prune

    expect(byType(msgs, 'multi-select-changed')).toHaveLength(before);
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

// #165 F3: the picker is a READ-ONLY affordance ("The pick click must never reach the page"), but
// only `click` was cancelled. A mousedown/mouseup pair IS a drag on an HTML5 drag-and-drop board
// (Trello/Jira-style), so a shift-click multi-selection dropped a real card into another column —
// not a recorder event, so nothing could undo it.
describe('read-only guarantee', () => {
  const swallowed = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu'];

  function fire(el: Element, type: string): { defaultPrevented: boolean; sawPage: boolean } {
    let sawPage = false;
    const spy = (): void => {
      sawPage = true;
    };
    el.addEventListener(type, spy);
    const e = new MouseEvent(type, { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    el.removeEventListener(type, spy);
    return { defaultPrevented: e.defaultPrevented, sawPage };
  }

  it('cancels every page-mutating pointer event while active', () => {
    document.body.innerHTML = '<div id="card" draggable="true">Card</div>';
    const { picker } = spawn();
    picker.start();

    for (const type of swallowed) {
      const { defaultPrevented, sawPage } = fire(byId('card'), type);
      expect([type, defaultPrevented, sawPage]).toEqual([type, true, false]);
    }
  });

  it('releases the page again after stop', () => {
    document.body.innerHTML = '<div id="card">Card</div>';
    const { picker } = spawn();
    picker.start();
    picker.stop();

    for (const type of swallowed) {
      const { defaultPrevented, sawPage } = fire(byId('card'), type);
      expect([type, defaultPrevented, sawPage]).toEqual([type, false, true]);
    }
  });

  it('leaves the page alone before start', () => {
    document.body.innerHTML = '<div id="card">Card</div>';
    spawn();
    expect(fire(byId('card'), 'mousedown').sawPage).toBe(true);
  });
});

// #165 F4: a composed event that crossed a shadow boundary is RETARGETED to the outermost host by
// the time it reaches the picker's `document` listener, so `e.target` named the custom element and
// the agent styled a host that is usually `display: contents` — nothing visibly changed and the
// changeset shipped a selector for the wrong element.
describe('shadow DOM targets', () => {
  function mountShadow(): Element {
    document.body.innerHTML = '<shop-button id="host"></shop-button>';
    const root = byId('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button data-testid="buy">Buy</button>';
    const inner = root.querySelector('button');
    if (!inner) throw new Error('fixture');
    return inner;
  }

  it('hovers the node inside the shadow root, not the host', () => {
    const inner = mountShadow();
    const { picker } = spawn();
    picker.start();
    inner.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));

    expect(shadow().querySelector('.dz-tag')?.textContent).toBe('button');
    expect(shadow().querySelector('.dz-sel')?.textContent).toBe('#host >>> [data-testid="buy"]');
  });

  it('picks the node inside the shadow root, not the host', () => {
    const inner = mountShadow();
    const { picker, msgs } = spawn();
    picker.start();
    inner.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 }),
    );

    const picked = byType(msgs, 'element-picked')[0];
    expect(picked?.type === 'element-picked' && picked.candidates[0]?.value).toBe(
      '#host >>> [data-testid="buy"]',
    );
  });
});

describe('quick pick (Alt+click, no mode to enter)', () => {
  // The point of the feature: answer "what are you referring to?" without a mode switch. You are
  // already looking at the element, so you point at it — and the panel grounds the next
  // instruction in its stable selector instead of the model guessing from prose.
  it('Alt+click pins the clicked element and emits the SAME element-picked as the armed picker', () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const { picker, msgs } = spawn();
    picker.enableQuickPick();

    const event = click(byId('cta'), { altKey: true });

    const picked = byType(msgs, 'element-picked');
    expect(picked).toHaveLength(1);
    expect(picked[0]?.type === 'element-picked' && picked[0].candidates[0]?.value).toBe('#cta');
    // Read-only contract: the gesture must never reach the page (no nav, no page handler).
    expect(event.defaultPrevented).toBe(true);
    // And it does NOT arm the full picker — no hover tracking, no picker-state. (The shadow host
    // IS mounted: the confirmation flash lives in it.)
    expect(picker.isActive()).toBe(false);
    expect(byType(msgs, 'picker-state')).toHaveLength(0);
  });

  it('leaves an UNMODIFIED click completely alone — it is live on every page', () => {
    document.body.innerHTML = '<a id="link" href="#x">Go</a>';
    const { picker, msgs } = spawn();
    picker.enableQuickPick();

    const event = click(byId('link'));

    expect(byType(msgs, 'element-picked')).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('swallows the modifier gesture’s mousedown too — a drag board must not receive it', () => {
    document.body.innerHTML = '<div id="card" draggable="true">Card</div>';
    const { picker } = spawn();
    picker.enableQuickPick();

    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      altKey: true,
    });
    byId('card').dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);

    // …but an unmodified mousedown still passes through.
    const plain = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    byId('card').dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });

  it('defers to the ARMED picker: while it is up, its own handler owns the click', () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const { picker, msgs } = spawn();
    picker.enableQuickPick();
    picker.start();

    click(byId('cta'), { altKey: true });

    // Exactly one pick, not two — the quick-pick handler stands down while `active`.
    expect(byType(msgs, 'element-picked')).toHaveLength(1);
  });

  it('disableQuickPick and destroy both release the listeners', () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const { picker, msgs } = spawn();
    picker.enableQuickPick();
    picker.disableQuickPick();

    const event = click(byId('cta'), { altKey: true });
    expect(byType(msgs, 'element-picked')).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('quick pick hover (see the target before you take it)', () => {
  const keydown = (opts: KeyboardEventInit): void => {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...opts }));
  };
  const keyup = (opts: KeyboardEventInit): void => {
    document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, ...opts }));
  };

  it('holding the modifier mounts the overlay and outlines the element under the pointer', () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const { picker } = spawn();
    picker.enableQuickPick();

    expect(document.getElementById(PICKER_HOST_ID)).toBeNull(); // nothing until it is held
    keydown({ key: 'Alt', altKey: true });
    over(byId('cta'));

    const hover = shadow().querySelector('.dz-hover');
    expect(hover).not.toBeNull();
    expect(hover?.classList.contains('dz-hidden')).toBe(false);
    // The pill names the resolved selector, so you can see WHAT you are about to pin.
    expect(shadow().querySelector('.dz-pill')?.classList.contains('dz-hidden')).toBe(false);
  });

  it('releasing the modifier clears the outline', () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const { picker } = spawn();
    picker.enableQuickPick();
    keydown({ key: 'Alt', altKey: true });
    over(byId('cta'));
    keyup({ key: 'Alt', altKey: false });

    expect(shadow().querySelector('.dz-hover')?.classList.contains('dz-hidden')).toBe(true);
  });

  it('losing window focus disarms — an Alt+Tab must not strand the outline on the page', () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const { picker } = spawn();
    picker.enableQuickPick();
    keydown({ key: 'Alt', altKey: true });
    over(byId('cta'));

    window.dispatchEvent(new Event('blur'));
    expect(shadow().querySelector('.dz-hover')?.classList.contains('dz-hidden')).toBe(true);
  });

  it('does not track hover without the modifier held', () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const { picker } = spawn();
    picker.enableQuickPick();
    over(byId('cta'));
    expect(document.getElementById(PICKER_HOST_ID)).toBeNull();
  });

  it('the pick flashes a confirmation box and drops the hover outline', () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const { picker } = spawn();
    picker.enableQuickPick();
    keydown({ key: 'Alt', altKey: true });
    over(byId('cta'));
    click(byId('cta'), { altKey: true });

    expect(shadow().querySelectorAll('.dz-flash')).toHaveLength(1);
    expect(shadow().querySelector('.dz-hover')?.classList.contains('dz-hidden')).toBe(true);
  });
});

describe('quick pick chord (Alt anywhere, Ctrl outside a link)', () => {
  it('Ctrl+click picks an ordinary element', () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const { picker, msgs } = spawn();
    picker.enableQuickPick();

    const event = click(byId('cta'), { ctrlKey: true });

    expect(byType(msgs, 'element-picked')).toHaveLength(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl+click on a LINK is left to the browser — that chord is open-in-a-new-tab', () => {
    document.body.innerHTML = '<a id="link" href="/x"><span id="inner">Go</span></a>';
    const { picker, msgs } = spawn();
    picker.enableQuickPick();

    const onLink = click(byId('link'), { ctrlKey: true });
    // …including a click on something nested INSIDE the link.
    const onInner = click(byId('inner'), { ctrlKey: true });

    expect(byType(msgs, 'element-picked')).toHaveLength(0);
    expect(onLink.defaultPrevented).toBe(false);
    expect(onInner.defaultPrevented).toBe(false);
  });

  it('Alt+click still works on a link, where Ctrl deliberately does not', () => {
    document.body.innerHTML = '<a id="link" href="/x">Go</a>';
    const { picker, msgs } = spawn();
    picker.enableQuickPick();

    const event = click(byId('link'), { altKey: true });

    expect(byType(msgs, 'element-picked')).toHaveLength(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('isQuickPickChord: the pure rule, independent of the DOM', () => {
    const link = document.createElement('a');
    link.setAttribute('href', '/x');
    expect(isQuickPickChord({ altKey: true, ctrlKey: false })).toBe(true);
    expect(isQuickPickChord({ altKey: true, ctrlKey: false }, link)).toBe(true);
    expect(isQuickPickChord({ altKey: false, ctrlKey: true })).toBe(true);
    expect(isQuickPickChord({ altKey: false, ctrlKey: true }, link)).toBe(false);
    expect(isQuickPickChord({ altKey: false, ctrlKey: false })).toBe(false);
  });

  it('either modifier arms the hover highlight — highlighting takes nothing away', () => {
    expect(isQuickPickHoverChord({ altKey: true, ctrlKey: false })).toBe(true);
    expect(isQuickPickHoverChord({ altKey: false, ctrlKey: true })).toBe(true);
    expect(isQuickPickHoverChord({ altKey: false, ctrlKey: false })).toBe(false);
  });

  it('holding Ctrl highlights, exactly like Alt', () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const { picker } = spawn();
    picker.enableQuickPick();

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true }));
    over(byId('cta'));

    expect(shadow().querySelector('.dz-hover')?.classList.contains('dz-hidden')).toBe(false);
  });
});

describe('content-script takeover (why the chord looked dead after an update)', () => {
  // Reloading an unpacked extension leaves the OLD content script in every open tab with its
  // `chrome.*` bridge invalidated — a corpse that still holds capture-phase listeners and still
  // calls preventDefault(). The repair (`reinjectAllTabs`) only works if the new instance can
  // evict the old one; a boolean "already loaded" guard let the corpse win and the tab was left
  // with no working tools and a chord that did nothing.
  //
  // `createPicker` is the piece that owns those listeners, so this asserts the eviction contract
  // the content entrypoint relies on: destroying an instance must fully release the document.
  it('a destroyed picker stops intercepting — the replacement gets the clicks', () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const first = spawn();
    first.picker.enableQuickPick();
    // It is live: the chord is swallowed and pinned.
    expect(click(byId('cta'), { altKey: true }).defaultPrevented).toBe(true);
    expect(byType(first.msgs, 'element-picked')).toHaveLength(1);

    // Evict it, the way a re-injection does.
    first.picker.destroy();
    expect(click(byId('cta'), { altKey: true }).defaultPrevented).toBe(false);
    expect(byType(first.msgs, 'element-picked')).toHaveLength(1); // no new pick from the corpse

    // The replacement now owns the chord, and only it emits.
    const second = spawn();
    second.picker.enableQuickPick();
    expect(click(byId('cta'), { altKey: true }).defaultPrevented).toBe(true);
    expect(byType(second.msgs, 'element-picked')).toHaveLength(1);
    expect(byType(first.msgs, 'element-picked')).toHaveLength(1);
  });

  it('a destroyed picker also releases the hover chord and unmounts its overlay', () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const { picker } = spawn();
    picker.enableQuickPick();
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, altKey: true }));
    over(byId('cta'));
    expect(document.getElementById(PICKER_HOST_ID)).not.toBeNull();

    picker.destroy();
    expect(document.getElementById(PICKER_HOST_ID)).toBeNull();
    // And holding the chord again does not resurrect it.
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, altKey: true }));
    over(byId('cta'));
    expect(document.getElementById(PICKER_HOST_ID)).toBeNull();
  });
});
