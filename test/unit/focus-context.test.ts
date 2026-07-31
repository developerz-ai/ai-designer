import { describe, expect, it } from 'vitest';
import { focusContextLine, groundUserText } from '@/agent/focus-context';
import type { StableSelector } from '@/shared/messages';

// #165 S6 unit: the picked element becomes the turn's grounded "this".
//
// The shipped failure: the picker resolved a selector, relayed it to the panel for DISPLAY only,
// and nothing carried it back. The user clicked the hero CTA (chip: `.hero__cta`), typed "make this
// 20% bigger", and the SW got the text alone — so on a page with several CTAs the agent restyled
// the wrong one while the chip kept claiming the element was attached.

const cta: StableSelector = { value: '.hero__cta', strategy: 'data-attr', fragile: false };
const hero: StableSelector = { value: '#hero', strategy: 'id', fragile: false };
const shaky: StableSelector = {
  value: 'div > p:nth-child(3)',
  strategy: 'css-path',
  fragile: true,
};

describe('focusContextLine', () => {
  it('is null when nothing is picked — a plain instruction gains no noise', () => {
    expect(focusContextLine()).toBeNull();
    expect(focusContextLine(undefined, [])).toBeNull();
  });

  it('names the single focused element and how it was resolved', () => {
    const line = focusContextLine(cta);
    expect(line).toContain('.hero__cta');
    expect(line).toContain('data-attr');
    expect(line).toContain('"this"');
  });

  it('carries fragility through, so the model knows how far to trust the selector', () => {
    expect(focusContextLine(shaky)).toContain('fragile');
    expect(focusContextLine(cta)).not.toContain('fragile');
  });

  it('lists every element of a multi-selection with its count', () => {
    const line = focusContextLine(undefined, [cta, hero]);
    expect(line).toContain('2 elements');
    expect(line).toContain('.hero__cta');
    expect(line).toContain('#hero');
  });

  it('de-duplicates the single focus out of the multi-set — one element, not two targets', () => {
    const line = focusContextLine(cta, [cta, hero]) ?? '';
    expect(line).toContain('2 elements');
    expect(line.match(/\.hero__cta/g)).toHaveLength(1);
  });

  it('puts the explicit single focus first when both are given', () => {
    const line = focusContextLine(hero, [cta]) ?? '';
    expect(line.indexOf('#hero')).toBeLessThan(line.indexOf('.hero__cta'));
  });
});

describe('groundUserText', () => {
  it('returns the instruction unchanged when nothing is picked', () => {
    expect(groundUserText('make the CTA orange')).toBe('make the CTA orange');
  });

  it('prepends the grounding so the model can resolve "this"', () => {
    const grounded = groundUserText('make this 20% bigger', cta);
    expect(grounded).toContain('.hero__cta');
    expect(grounded.endsWith('make this 20% bigger')).toBe(true);
    // The grounding is a separate leading line, never spliced into the user's words.
    expect(grounded.split('\n').at(-1)).toBe('make this 20% bigger');
  });

  it('grounds a multi-selection the same way', () => {
    const grounded = groundUserText('align these', undefined, [cta, hero]);
    expect(grounded).toContain('#hero');
    expect(grounded.split('\n').at(-1)).toBe('align these');
  });
});
