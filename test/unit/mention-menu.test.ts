import { describe, expect, it } from 'vitest';
import { filterMentions, mentionQuery } from '@/entrypoints/sidepanel/components/chat/MentionMenu';
import { foldRecent } from '@/entrypoints/sidepanel/stores/focus';
import type { StableSelector } from '@/shared/messages';

// #175 — `@` in the composer. The three pure pieces: when a mention is open, what it matches, and
// what the menu has to offer. All of them are decisions the UI cannot be trusted to re-derive.

function sel(value: string, strategy: StableSelector['strategy'] = 'css-path'): StableSelector {
  return { value, strategy, fragile: false };
}

describe('mentionQuery', () => {
  it('opens on an `@` that starts a word', () => {
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('make @her', 9)).toEqual({ start: 5, query: 'her' });
    expect(mentionQuery('line\n@h', 7)).toEqual({ start: 5, query: 'h' });
  });

  it('does NOT open mid-word — an email address is not a mention', () => {
    // The single most common `@` in prose. Without the word-boundary test, typing an address
    // pops a menu over the composer on every keystroke.
    expect(mentionQuery('din@developerz.ai', 17)).toBeNull();
    expect(mentionQuery('user@host', 9)).toBeNull();
  });

  it('closes once the query runs past a space', () => {
    // Otherwise one stray `@` leaves the menu open for the rest of the sentence, filtering on
    // text the user is writing for the agent, not for the menu.
    expect(mentionQuery('@hero bigger', 12)).toBeNull();
  });

  it('reads the run under the CARET, not the end of the text', () => {
    // The caret can sit before later text (click, arrow keys) — the mention is whatever run the
    // caret is in, which is why Composer re-syncs on `select` and not only on `input`.
    expect(mentionQuery('@hero and @nav', 5)).toEqual({ start: 0, query: 'hero' });
    expect(mentionQuery('@hero and @nav', 14)).toEqual({ start: 10, query: 'nav' });
  });
});

describe('filterMentions', () => {
  const items = [sel('.hero > h1'), sel('#nav', 'id'), sel('.pricing .card:nth-child(2)')];

  it('matches the raw selector case-insensitively', () => {
    expect(filterMentions(items, 'HERO')).toEqual([items[0]]);
    expect(filterMentions(items, 'pricing')).toEqual([items[2]]);
  });

  it('returns everything for an empty query', () => {
    expect(filterMentions(items, '')).toEqual(items);
    expect(filterMentions(items, '   ')).toEqual(items);
  });
});

describe('foldRecent', () => {
  it('puts newly-seen references first', () => {
    expect(foldRecent([sel('#a')], [sel('#b')]).map((s) => s.value)).toEqual(['#b', '#a']);
  });

  it('promotes a repeat instead of duplicating it', () => {
    const out = foldRecent([sel('#a'), sel('#b')], [sel('#b')]);
    expect(out.map((s) => s.value)).toEqual(['#b', '#a']);
  });

  it('caps the history so the menu stays a menu', () => {
    const many = Array.from({ length: 12 }, (_, i) => sel(`#e${i}`));
    expect(foldRecent([], many)).toHaveLength(8);
    // Newest first: the last one folded in leads.
    expect(foldRecent([], many)[0]?.value).toBe('#e11');
  });
});
