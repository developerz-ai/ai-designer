import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOverlay, OVERLAY_HOST_ID, type Overlay } from '@/dom/overlay';

// Overlay unit tests (jsdom). The overlay is pure DOM (no chrome.*, no bus), so we drive it through
// its API and assert the shadow-DOM chrome. getBoundingClientRect is 0×0 under jsdom, so positions
// aren't asserted — only that the highlight box is shown/hidden for the right targets. Every spawned
// overlay is destroyed in afterEach: it adds capture-phase scroll listeners to `document`.

const alive: Overlay[] = [];

function spawn(): Overlay {
  const overlay = createOverlay(document);
  alive.push(overlay);
  return overlay;
}

function host(): HTMLElement | null {
  const el = document.getElementById(OVERLAY_HOST_ID);
  return el instanceof HTMLElement ? el : null;
}

function shadow(): ShadowRoot {
  const h = host();
  if (!h?.shadowRoot) throw new Error('overlay host not mounted');
  return h.shadowRoot;
}

function q(selector: string): HTMLElement {
  const el = shadow().querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(`overlay node missing: ${selector}`);
  return el;
}

const mark = (): HTMLElement => q('.dz-mark');
const now = (): HTMLElement => q('.dz-now');
const hostCount = (): number => document.querySelectorAll('[data-dz-designer="overlay"]').length;
const isHidden = (el: HTMLElement): boolean => el.classList.contains('dz-hidden');
const logItems = (): string[] =>
  Array.from(shadow().querySelectorAll('.dz-log-item')).map((n) => n.textContent ?? '');

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const o of alive.splice(0)) o.destroy();
});

describe('overlay lifecycle', () => {
  it('enable mounts the shadow host; disable removes it', () => {
    const o = spawn();
    expect(o.isEnabled()).toBe(false);
    expect(host()).toBeNull();

    o.enable();
    expect(o.isEnabled()).toBe(true);
    expect(host()?.shadowRoot).toBeTruthy();

    o.disable();
    expect(o.isEnabled()).toBe(false);
    expect(host()).toBeNull();
  });

  it('enable is idempotent — a single host', () => {
    const o = spawn();
    o.enable();
    o.enable();
    expect(hostCount()).toBe(1);
  });

  it('disable is idempotent', () => {
    const o = spawn();
    o.enable();
    o.disable();
    expect(() => o.disable()).not.toThrow();
    expect(host()).toBeNull();
  });

  it('toggle flips, and forces to the boolean when given', () => {
    const o = spawn();
    o.toggle();
    expect(o.isEnabled()).toBe(true);
    o.toggle();
    expect(o.isEnabled()).toBe(false);
    o.toggle(true);
    o.toggle(true);
    expect(o.isEnabled()).toBe(true);
    expect(hostCount()).toBe(1);
    o.toggle(false);
    expect(o.isEnabled()).toBe(false);
  });

  it('destroy tears the host out', () => {
    const o = spawn();
    o.enable();
    o.destroy();
    expect(host()).toBeNull();
  });
});

describe('overlay disabled adds nothing to the page', () => {
  it('step before enable mounts no DOM', () => {
    const o = spawn();
    o.step({ label: 'querying .hero', selector: '#hero' });
    expect(host()).toBeNull();
  });

  it('clear before enable is a no-op', () => {
    const o = spawn();
    expect(() => o.clear()).not.toThrow();
    expect(host()).toBeNull();
  });

  it('after disable the host is gone', () => {
    const o = spawn();
    o.enable();
    o.step({ label: 'setStyle → padding', selector: '#hero' });
    o.disable();
    expect(host()).toBeNull();
  });
});

describe('overlay step rendering', () => {
  it('sets the current-step banner text', () => {
    const o = spawn();
    o.enable();
    o.step({ label: 'querying .hero' });
    expect(now().textContent).toBe('querying .hero');
  });

  it('accumulates steps newest-first in the log', () => {
    const o = spawn();
    o.enable();
    o.step({ label: 'a' });
    o.step({ label: 'b' });
    o.step({ label: 'c' });
    expect(logItems()).toEqual(['c', 'b', 'a']);
  });

  it('caps the log, dropping the oldest', () => {
    const o = spawn();
    o.enable();
    for (let i = 1; i <= 8; i += 1) o.step({ label: `s${i}` });
    expect(logItems()).toEqual(['s8', 's7', 's6', 's5', 's4', 's3']);
    expect(logItems()).not.toContain('s1');
  });

  it('an act step flips the accent on banner + highlight; a later read clears it', () => {
    const o = spawn();
    document.body.innerHTML = '<div id="hero"></div>';
    o.enable();
    o.step({ label: 'setStyle → padding', selector: '#hero', kind: 'act' });
    expect(now().classList.contains('dz-act')).toBe(true);
    expect(mark().classList.contains('dz-act')).toBe(true);

    o.step({ label: 'querying .hero', selector: '#hero', kind: 'read' });
    expect(now().classList.contains('dz-act')).toBe(false);
  });

  it('renders the label as text, never as markup', () => {
    const o = spawn();
    o.enable();
    o.step({ label: '<img src=x onerror=alert(1)>' });
    expect(now().textContent).toBe('<img src=x onerror=alert(1)>');
    expect(shadow().querySelector('img')).toBeNull();
  });
});

describe('overlay highlight', () => {
  it('shows the box for a resolvable selector', () => {
    const o = spawn();
    document.body.innerHTML = '<section id="hero"></section>';
    o.enable();
    o.step({ label: 'querying #hero', selector: '#hero' });
    expect(isHidden(mark())).toBe(false);
  });

  it('hides the box for an unresolvable selector', () => {
    const o = spawn();
    o.enable();
    o.step({ label: 'querying .gone', selector: '.gone' });
    expect(isHidden(mark())).toBe(true);
  });

  it('hides the box for a step with neither selector nor rect', () => {
    const o = spawn();
    document.body.innerHTML = '<div id="hero"></div>';
    o.enable();
    o.step({ label: 'query', selector: '#hero' });
    expect(isHidden(mark())).toBe(false);
    o.step({ label: 'thinking' });
    expect(isHidden(mark())).toBe(true);
  });

  it('shows the box for an explicit rect', () => {
    const o = spawn();
    o.enable();
    o.step({ label: 'picked', rect: { x: 4, y: 8, width: 100, height: 40 } });
    expect(isHidden(mark())).toBe(false);
  });

  it('ignores a selector that resolves to the overlay host itself', () => {
    const o = spawn();
    o.enable();
    o.step({ label: 'self', selector: `#${OVERLAY_HOST_ID}` });
    expect(isHidden(mark())).toBe(true);
  });

  it('clear empties the log + hides the box but keeps the host', () => {
    const o = spawn();
    document.body.innerHTML = '<div id="hero"></div>';
    o.enable();
    o.step({ label: 'querying #hero', selector: '#hero' });
    o.clear();
    expect(logItems()).toEqual([]);
    expect(now().textContent).toBe('ready');
    expect(isHidden(mark())).toBe(true);
    expect(host()).not.toBeNull();
  });
});

describe('overlay reflow', () => {
  it('drops the outline when the tracked element leaves the DOM', () => {
    const o = spawn();
    document.body.innerHTML = '<div id="hero"></div>';
    o.enable();
    o.step({ label: 'querying #hero', selector: '#hero' });
    expect(isHidden(mark())).toBe(false);

    document.getElementById('hero')?.remove();
    document.dispatchEvent(new Event('scroll'));
    expect(isHidden(mark())).toBe(true);
  });
});
