import { i18n } from '#i18n';
import { Icon } from '../Icon';
import './EmptyState.scss';
import type { Suggestion } from './SuggestionChips';
import { SuggestionChips } from './SuggestionChips';

// First-run placeholder for the Thread — shown instead of an empty scroll area before any turn
// has run this session. Left-aligned like Leo's intro (avatar, title, a muted "Automatic ⓘ" meta
// line, then full-width action rows), not a centred hero. Presentational only; the tap-to-send
// dispatch lives wherever the caller wires `onSelectSuggestion` (ChatPanel), matching
// SuggestionChips (CLAUDE.md "SolidJS + SRP").
export interface EmptyStateProps {
  onSelectSuggestion: (suggestion: Suggestion) => void;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <div class="dz-empty-state">
      {/* The glyph is wrapped rather than styled directly: `Icon` puts its own `.dz-icon--md`
          (width/height in `em`) on the same element, and an equal-specificity override from this
          component would win or lose on stylesheet order alone. */}
      <span class="dz-empty-state__avatar">
        <Icon name="agent" size="md" class="dz-icon--fixed" />
      </span>
      {/* `h2` under App's `h1` — a real heading, so the intro is reachable by heading navigation
          instead of being an unlabelled block of text. */}
      <h2 class="dz-empty-state__title">{i18n.t('empty.title')}</h2>

      {/* Leo's "Automatic ⓘ". Mode is inferred from the message (agent/modes.ts), so there is
          nothing to pick here — the ⓘ is decorative and the explanation it stands for is carried
          as visually-hidden text, which needs no interactive element to be announced. */}
      <p class="dz-empty-state__meta">
        <span>{i18n.t('empty.meta')}</span>
        <Icon name="info" size="sm" />
        <span class="dz-empty-state__meta-hint">{i18n.t('empty.metaHint.ariaLabel')}</span>
      </p>

      <p class="dz-empty-state__subtitle">{i18n.t('empty.subtitle')}</p>
      <SuggestionChips onSelect={props.onSelectSuggestion} />
    </div>
  );
}
