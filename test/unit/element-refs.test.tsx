import { describe, expect, it } from 'vitest';
import { humanName } from '@/entrypoints/sidepanel/components/chat/ContextChip';
import { INLINE_LIMIT, shouldCollapse } from '@/entrypoints/sidepanel/components/chat/ElementRefs';
import { orderedReferences } from '@/entrypoints/sidepanel/stores/focus';
import type { StableSelector } from '@/shared/messages';

// The element-reference row: the design's headline change (one pin -> N numbered, named chips).
// Everything under test here is pure, so none of it needs a mount — the mounted contract that
// matters (the chips reach `send()`) is already covered by composer-view.test.tsx.

function sel(value: string, strategy: StableSelector['strategy'] = 'css-path'): StableSelector {
  return { value, strategy, fragile: false };
}

describe('humanName', () => {
  // The whole point of the chip: `.hero > div:nth-child(2)` tells a designer nothing about what
  // they just pinned, so the PRIMARY label is a word a person recognises.
  it('uses an id verbatim — an id already is the human name', () => {
    expect(humanName(sel('#cta', 'id'))).toBe('#cta');
    expect(humanName(sel('div#hero-banner'))).toBe('#hero-banner');
    // Scope before the last segment is not what was pinned.
    expect(humanName(sel('main .wrap > #signup'))).toBe('#signup');
  });

  it('titleises the class of the LAST segment, keeping its sibling position', () => {
    expect(humanName(sel('.pricing .card'))).toBe('Card');
    expect(humanName(sel('.pricing .card:nth-of-type(2)'))).toBe('Card 2');
    expect(humanName(sel('.hero .hero-title'))).toBe('Hero title');
    expect(humanName(sel('.grid > .heroTitle'))).toBe('Hero title');
  });

  it('falls back to a word for the tag when there is no id or class', () => {
    expect(humanName(sel('section.hero > h1'))).toBe('Heading');
    expect(humanName(sel('header nav'))).toBe('Nav');
    expect(humanName(sel('ul > li:nth-child(3)'))).toBe('List item 3');
    // Unknown tag (a custom element): titleised rather than guessed at.
    expect(humanName(sel('x-widget'))).toBe('X widget');
  });

  // The `text` strategy does NOT carry the matched text: `StableSelector.value` must always be a
  // legal `querySelector` argument, so a text candidate is the bare tag (src/dom/selector.ts).
  // Naming it after its strategy rather than its value produced chips reading `“h1”`.
  it('treats every strategy the same — the value is always a selector', () => {
    expect(humanName(sel('h1', 'text'))).toBe('Heading');
    expect(humanName(sel('button', 'text'))).toBe('Button');
  });

  it('never returns an empty chip, whatever the selector looks like', () => {
    expect(humanName(sel(''))).toBe('');
    expect(humanName(sel('   '))).toBe('   ');
    expect(humanName(sel('[data-test="x"]', 'data-attr'))).toBeTruthy();
  });

  it('truncates so a long class cannot widen the 360px panel', () => {
    const long = humanName(sel('.a-very-long-utility-class-name-that-goes-on-and-on'));
    expect(long.length).toBeLessThanOrEqual(28);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('orderedReferences', () => {
  // The numbering a user sees on a chip has to be the numbering the agent is grounded on, so the
  // order is fixed: the single pin first, then the shift-multi set.
  it('puts the pin first, then the multi set', () => {
    expect(orderedReferences(sel('#a'), [sel('#b'), sel('#c')])).toEqual([
      sel('#a'),
      sel('#b'),
      sel('#c'),
    ]);
  });

  it('is just the multi set when nothing is pinned', () => {
    expect(orderedReferences(null, [sel('#b')])).toEqual([sel('#b')]);
    expect(orderedReferences(null, [])).toEqual([]);
  });
});

describe('shouldCollapse', () => {
  // Above the limit the row folds into one stack chip. The threshold exists so the composer never
  // moves as references are attached — a row that wraps pushes the input down mid-sentence.
  it('renders inline up to the limit and collapses past it', () => {
    expect(INLINE_LIMIT).toBe(3);
    expect(shouldCollapse(0)).toBe(false);
    expect(shouldCollapse(3)).toBe(false);
    expect(shouldCollapse(4)).toBe(true);
    expect(shouldCollapse(12)).toBe(true);
  });
});
