import { describe, expect, it } from 'vitest';
import { detectFrameworkHints } from '@/dom/framework-hints';

// Per-element CSS-framework detection (#9). Pure heuristics over class tokens + marker
// attributes, driven here against jsdom elements.

function el(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  const first = host.firstElementChild;
  if (!first) throw new Error('fixture produced no element');
  return first;
}

describe('detectFrameworkHints — tailwind', () => {
  it('emits one hint per utility token on a cluster (>=2)', () => {
    const target = el(
      '<button class="flex items-center gap-2 rounded-md bg-indigo-600">x</button>',
    );
    const hints = detectFrameworkHints(target);
    expect(hints).toContain('tailwind:flex');
    expect(hints).toContain('tailwind:items-center');
    expect(hints).toContain('tailwind:gap-2');
    expect(hints.filter((h) => h.startsWith('tailwind:'))).toHaveLength(5);
  });

  it('strips responsive/state variant prefixes before probing the base', () => {
    const target = el('<div class="md:flex hover:bg-sky-700"></div>');
    const hints = detectFrameworkHints(target);
    expect(hints).toContain('tailwind:md:flex');
    expect(hints).toContain('tailwind:hover:bg-sky-700');
  });

  it('stays silent on a single utility-shaped token (false-positive guard)', () => {
    expect(detectFrameworkHints(el('<div class="flex"></div>'))).toEqual([]);
    expect(detectFrameworkHints(el('<div class="shadow"></div>'))).toEqual([]);
  });

  it('ignores hand-named classes that do not look like utilities', () => {
    expect(detectFrameworkHints(el('<div class="card card--featured"></div>'))).toEqual([]);
  });
});

describe('detectFrameworkHints — css modules / styled / emotion', () => {
  it('detects css-module generated locals', () => {
    const hints = detectFrameworkHints(el('<div class="Button_root__3x7ka"></div>'));
    expect(hints).toEqual(['css-module:Button_root__3x7ka']);
  });

  it('detects leading-underscore generated segments', () => {
    const hints = detectFrameworkHints(el('<div class="_3x7ka9"></div>'));
    expect(hints).toEqual(['css-module:_3x7ka9']);
  });

  it('detects styled-components componentId classes and the data-styled marker', () => {
    const hints = detectFrameworkHints(el('<div class="sc-bxivhb"></div>'));
    expect(hints).toEqual(['styled:sc-bxivhb']);
    expect(detectFrameworkHints(el('<div data-styled></div>'))).toEqual(['styled:data-styled']);
  });

  it('detects emotion generated classes', () => {
    const hints = detectFrameworkHints(el('<div class="css-1dbjc4n"></div>'));
    expect(hints).toEqual(['emotion:css-1dbjc4n']);
  });

  it('does not flag short sc-/css- lookalikes', () => {
    expect(detectFrameworkHints(el('<div class="sc-1 css-a"></div>'))).toEqual([]);
  });
});

describe('detectFrameworkHints — robustness', () => {
  it('returns [] for a classless element', () => {
    expect(detectFrameworkHints(el('<span>text</span>'))).toEqual([]);
  });

  it('reads the class attribute (SVGAnimatedString-safe)', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'flex items-center');
    expect(detectFrameworkHints(svg)).toContain('tailwind:flex');
  });

  it('caps hints at 40 for utility-soup elements', () => {
    const many = Array.from({ length: 60 }, (_, i) => `m${i % 2 === 0 ? 't' : 'b'}-${i}`).join(' ');
    const hints = detectFrameworkHints(el(`<div class="flex ${many}"></div>`));
    expect(hints.length).toBeLessThanOrEqual(40);
  });

  it('dedupes repeated tokens', () => {
    const hints = detectFrameworkHints(el('<div class="flex flex items-center"></div>'));
    expect(hints.filter((h) => h === 'tailwind:flex')).toHaveLength(1);
  });
});
