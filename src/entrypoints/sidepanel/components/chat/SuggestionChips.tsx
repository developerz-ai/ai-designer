import { For, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { Mode } from '@/shared/messages';
import { Icon } from '../Icon';
import type { IconName } from '../icon-registry';
import './SuggestionChips.scss';

// Quick-start tasks — one tap fills a common first instruction instead of typing it. Rendered as
// Leo does: full-width, left-aligned action rows with a leading glyph, not centred wrapped pills
// at 0.85em. Shown by EmptyState before any turn has run; a caller (ChatPanel) decides what a tap
// does via `onSelect`, so this stays presentational + dispatch-only (CLAUDE.md "SolidJS + SRP").
// `mode` is a hint for `send()`'s optional `Mode` param — undefined lets `agent/modes.ts`'s
// `inferMode` read it off the prompt text instead.
export interface Suggestion {
  label: string;
  prompt: string;
  mode?: Mode;
  /** Leading glyph for the row. Optional — a row without one still lays out correctly. */
  icon?: IconName;
}

// A tap SENDS immediately (`ChatPanel.selectSuggestion` → `sendMessage`), so every entry has to be
// a COMPLETE instruction that works on WHATEVER page the user is on. The previous three failed
// that and a real user said so: "Copy nvidia's hero" hardcoded someone else's brand and assumed
// you wanted it, "Debug this filter" named a control most pages don't have, and "Ship to
// developerz.ai" offered a TERMINAL action as an opener — before the first turn there are no
// accepted edits to ship. The replacements ask for work any page can receive; the set is asserted
// in test/unit/suggestion-chips.test.ts, prompts included.
export const SUGGESTIONS: Suggestion[] = [
  {
    label: i18n.t('suggestion.modernize.label'),
    prompt: i18n.t('suggestion.modernize.prompt'),
    // NO `mode` key, deliberately. `Mode` is copy | debug, and this turn is neither: it is ordinary
    // design work on the page already in front of you. Pinning 'copy' looked right from the base
    // MODES prose and was wrong in practice — the copy ADDENDUM (`modes.ts` COPY_ADDENDUM) is
    // written entirely around a REFERENCE ("Read the reference's identity first… browsing it in a
    // background tab"), so the agent was instructed to go read a site the user never named. With
    // the key omitted, `inferMode` runs, and the prompt is worded to match neither keyword list, so
    // the turn carries no addendum at all — the correct amount of instruction for "make this page
    // nicer". The two rows below pin `debug` because we DO know their activity at authoring time.
    // Spacing/type/colour dials, not a duplicate-page glyph: nothing is being copied from anywhere.
    icon: 'sliders',
  },
  {
    label: i18n.t('suggestion.mobile.label'),
    prompt: i18n.t('suggestion.mobile.prompt'),
    // Diagnostic: find what breaks at a narrow width, then fix it. The debug addendum's
    // `setDevice` + `checkResponsive` emphasis is exactly this turn's tool order.
    mode: 'debug',
    // Look at the page at another width — `bug` belongs to a defect report, not to a look-and-see.
    icon: 'eye',
  },
  {
    label: i18n.t('suggestion.accessibility.label'),
    prompt: i18n.t('suggestion.accessibility.prompt'),
    // Diagnostic: an audit that reports findings with evidence, which is what debug mode's
    // `a11ySnapshot`-first emphasis and repro-steps discipline produce.
    mode: 'debug',
    // "Find …" — a search, not a `warning` triangle: that glyph is this panel's error signal and
    // would read as "this page is already broken" before the agent has looked at anything.
    icon: 'search',
  },
];

export interface SuggestionChipsProps {
  onSelect: (suggestion: Suggestion) => void;
}

export function SuggestionChips(props: SuggestionChipsProps) {
  return (
    <ul class="dz-suggestion-chips">
      <For each={SUGGESTIONS}>
        {(s) => (
          <li>
            <button
              type="button"
              class="dz-suggestion-chips__row"
              onClick={() => props.onSelect(s)}
            >
              <Show when={s.icon}>
                {(name) => (
                  <Icon name={name()} size="sm" class="dz-suggestion-chips__icon dz-icon--fixed" />
                )}
              </Show>
              <span class="dz-suggestion-chips__label">{s.label}</span>
              {/* Trailing chevron: without it a bordered row with a leading glyph reads as a
                  status card. This is the affordance that says tapping it does something. */}
              <Icon name="chevronRight" size="sm" class="dz-suggestion-chips__go dz-icon--fixed" />
            </button>
          </li>
        )}
      </For>
    </ul>
  );
}
