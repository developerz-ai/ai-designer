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

// The set itself is fixed (asserted verbatim in test/unit/suggestion-chips.test.ts); only the
// `icon` field is new.
export const SUGGESTIONS: Suggestion[] = [
  {
    label: i18n.t('suggestion.copyHero.label'),
    prompt: i18n.t('suggestion.copyHero.prompt'),
    mode: 'copy',
    icon: 'copy',
  },
  {
    label: i18n.t('suggestion.debugFilter.label'),
    prompt: i18n.t('suggestion.debugFilter.prompt'),
    mode: 'debug',
    icon: 'bug',
  },
  {
    label: i18n.t('suggestion.ship.label'),
    prompt: i18n.t('suggestion.ship.prompt'),
    icon: 'ship',
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
