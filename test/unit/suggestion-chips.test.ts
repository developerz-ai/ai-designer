import { describe, expect, it } from 'vitest';
import { inferMode, resolveMode } from '@/agent/modes';
import { SUGGESTIONS } from '@/entrypoints/sidepanel/components/chat/SuggestionChips';
import { ICON_NAMES } from '@/entrypoints/sidepanel/components/icon-registry';

// The fixed task-chip set EmptyState surfaces before any turn has run (docs/plans task #68).
// The rendered rows — one control per suggestion, dispatching the suggestion object — are
// covered by empty-state.test.tsx; this file guards the data.
describe('SUGGESTIONS', () => {
  it('offers the modernize/mobile/accessibility starter chips', () => {
    const labels = SUGGESTIONS.map((s) => s.label);
    expect(labels).toEqual([
      'Modernize this page',
      'Check it on mobile',
      'Find accessibility problems',
    ]);
  });

  it('every chip has a non-empty prompt to send', () => {
    for (const s of SUGGESTIONS) {
      expect(s.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  // Leo's rows carry a leading glyph (#165). The field is optional on the type, but an
  // unregistered name would throw at render time rather than fall back — so pin it here instead
  // of discovering it in the panel.
  it('gives every chip a registered leading icon', () => {
    for (const s of SUGGESTIONS) {
      expect(s.icon).toBeDefined();
      expect(ICON_NAMES).toContain(s.icon);
    }
  });

  // THE MODE EACH CHIP ACTUALLY RESOLVES TO, run through the real resolver rather than asserted as
  // a stored value — because the stored value is not what reaches the agent. `resolveMode` is what
  // the SW calls, and the mode it returns drags a prompt ADDENDUM along with it.
  //
  // This is the assertion that would have caught a shipped bug. "Modernize this page" was pinned
  // `copy` on the reasoning that copy is the copy/DESIGN mode. But COPY_ADDENDUM is written entirely
  // around a REFERENCE — "Read the reference's identity first… browsing it in a background tab" —
  // and this request names no reference, so the agent was told to go read a site that does not
  // exist. A test on `s.mode === 'copy'` would have passed happily.
  //
  // So: design work must resolve to NO mode (there is no design value — `Mode` is copy | debug, and
  // no addendum is the right amount of instruction), and it must do so with the prompt text the user
  // actually sends, which means tripping neither keyword list.
  it.each([
    ['modernize', 0, undefined],
    ['mobile', 1, 'debug'],
    ['accessibility', 2, 'debug'],
  ])('the %s chip resolves to mode %s through the real resolver', (_name, index, expected) => {
    const s = SUGGESTIONS[index as number];
    if (!s) throw new Error('suggestion missing');
    expect(resolveMode(s.mode, s.prompt)).toBe(expected);
  });

  it('keeps the design prompt clear of BOTH keyword lists, so it stays addendum-free', () => {
    // Guards the guard: pinning `undefined` only helps while the text also infers nothing. A later
    // reword to "fix the spacing" or "redesign this" would silently re-attach an addendum.
    const design = SUGGESTIONS[0];
    if (!design) throw new Error('suggestion missing');
    expect(inferMode(design.prompt)).toBeUndefined();
  });

  // A tap SENDS the prompt unedited (`ChatPanel.selectSuggestion` → `sendMessage`), so a prompt
  // that needs filling in, or that names a site the user isn't on, ships exactly as written. Both
  // shipped: the retired set sent "Copy nvidia.com's hero section onto this page." and "Ship my
  // accepted edits to developerz.ai as a PR." at whatever page happened to be open.
  const PLACEHOLDER = /\[[^\]]*\]|\{[^}]*\}|<[^>]*>|\b(?:TODO|FIXME|XXX|foo|bar)\b/i;
  const THIRD_PARTY_SITE = /\b[a-z0-9-]+\.(?:com|ai|io|dev|org|net|co|app|xyz)\b/i;

  it.each(SUGGESTIONS)('$label sends a self-contained prompt', ({ prompt }) => {
    expect(prompt).not.toMatch(PLACEHOLDER);
    expect(prompt).not.toMatch(THIRD_PARTY_SITE);
  });

  // Guard the guard: two `not.toMatch` assertions pass just as happily against regexes that match
  // nothing, which is how a prompt check rots into decoration. These are the strings the rule
  // exists to reject.
  it.each([
    ["Copy nvidia.com's hero section onto this page.", THIRD_PARTY_SITE],
    ['Ship my accepted edits to developerz.ai as a PR.', THIRD_PARTY_SITE],
    ["Copy [reference site]'s hero onto this page.", PLACEHOLDER],
    ['Modernize this page. TODO: pick a palette.', PLACEHOLDER],
  ] as const)('rejects %j', (offender, detector) => {
    expect(offender).toMatch(detector);
  });
});
