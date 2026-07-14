import { describe, expect, it } from 'vitest';
import { readImages } from '@/dom/images';
import type { ImageInfo } from '@/shared/messages';

// Unit (jsdom): image enumeration + broken/oversize detection. jsdom doesn't load images or lay
// out, so natural/rendered sizes are stubbed per element via defineProperty / a getBoundingClientRect
// override — exactly the signals a real page would expose.

function mount(html: string): void {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fixture missing: #${id}`);
  return el;
}

function setNatural(img: HTMLImageElement, w: number, h: number, complete = true): void {
  Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true });
  Object.defineProperty(img, 'complete', { value: complete, configurable: true });
}

function setRendered(el: HTMLElement, w: number, h: number): void {
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h }) as DOMRect;
}

function find(images: ImageInfo[], predicate: (i: ImageInfo) => boolean): ImageInfo {
  const hit = images.find(predicate);
  if (!hit) throw new Error('no matching image');
  return hit;
}

describe('readImages — <img> enumeration', () => {
  it('reports src, alt and a stable selector', () => {
    mount('<img id="hero" src="https://cdn.test/a.png" alt="Hero banner" />');
    setNatural(byId('hero') as HTMLImageElement, 800, 600);

    const { images } = readImages(document, window);
    const hero = find(images, (i) => i.kind === 'img');

    expect(hero.src).toBe('https://cdn.test/a.png');
    expect(hero.alt).toBe('Hero banner');
    expect(hero.naturalWidth).toBe(800);
    expect(hero.selector.value).toBe('#hero');
    expect(hero.broken).toBe(false);
  });

  it('omits alt when the attribute is absent (a11y signal)', () => {
    mount('<img id="i" src="https://cdn.test/a.png" />');
    setNatural(byId('i') as HTMLImageElement, 10, 10);
    const hero = find(readImages(document, window).images, (i) => i.kind === 'img');
    expect(hero.alt).toBeUndefined();
  });

  it('flags a broken image (completed load, naturalWidth 0, has src)', () => {
    mount('<img id="bad" src="https://cdn.test/missing.png" alt="x" />');
    setNatural(byId('bad') as HTMLImageElement, 0, 0, true);

    const bad = find(readImages(document, window).images, (i) => i.selector.value === '#bad');
    expect(bad.broken).toBe(true);
    expect(bad.oversized).toBe(false);
  });

  it('does not flag a still-loading image as broken', () => {
    mount('<img id="loading" src="https://cdn.test/slow.png" />');
    setNatural(byId('loading') as HTMLImageElement, 0, 0, false); // not complete yet
    const img = find(readImages(document, window).images, (i) => i.selector.value === '#loading');
    expect(img.broken).toBe(false);
  });

  it('flags an oversized image (intrinsic >> rendered)', () => {
    mount('<img id="big" src="https://cdn.test/huge.png" alt="huge" />');
    const img = byId('big') as HTMLImageElement;
    setNatural(img, 2000, 2000);
    setRendered(img, 100, 100); // 2000 > 100 * dpr(1) * 2 → oversized

    const info = find(readImages(document, window).images, (i) => i.selector.value === '#big');
    expect(info.oversized).toBe(true);
    expect(info.renderedWidth).toBe(100);
  });

  it('does not flag oversize when the element is not laid out (rendered 0)', () => {
    mount('<img id="unlaid" src="https://cdn.test/a.png" />');
    setNatural(byId('unlaid') as HTMLImageElement, 2000, 2000); // rendered defaults to 0 in jsdom
    const info = find(readImages(document, window).images, (i) => i.selector.value === '#unlaid');
    expect(info.oversized).toBe(false);
  });
});

describe('readImages — CSS background-image', () => {
  it('enumerates a background-image and absolutizes its url', () => {
    mount('<div id="bg" style="background-image: url(\'/banner.png\')">x</div>');
    const bg = find(readImages(document, window).images, (i) => i.kind === 'background');
    expect(bg.selector.value).toBe('#bg');
    expect(bg.src.endsWith('/banner.png')).toBe(true);
    expect(bg.naturalWidth).toBe(0); // intrinsic size unknown for a CSS background
    expect(bg.broken).toBe(false);
  });

  it('ignores non-url backgrounds (gradients, none)', () => {
    mount(
      '<div id="grad" style="background-image: linear-gradient(#000, #fff)">g</div>' +
        '<div id="plain">p</div>',
    );
    const backgrounds = readImages(document, window).images.filter((i) => i.kind === 'background');
    expect(backgrounds).toHaveLength(0);
  });
});

describe('readImages — scope', () => {
  it('enumerates only within a selector-scoped subtree, including the scope element', () => {
    mount(
      '<section id="in"><img src="https://cdn.test/inside.png" /></section>' +
        '<img id="out" src="https://cdn.test/outside.png" />',
    );
    const section = byId('in');
    const { images } = readImages(section, window);
    expect(images.some((i) => i.src.endsWith('/inside.png'))).toBe(true);
    expect(images.some((i) => i.src.endsWith('/outside.png'))).toBe(false);
  });

  it('includes the scope element itself when it is an <img>', () => {
    mount('<img id="solo" src="https://cdn.test/solo.png" alt="solo" />');
    const { images } = readImages(byId('solo'), window);
    expect(images).toHaveLength(1);
    expect(images[0]?.src).toBe('https://cdn.test/solo.png');
  });
});
