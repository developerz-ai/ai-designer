import { Icon } from '../Icon';
import './EmptyState.scss';
import type { Suggestion } from './SuggestionChips';
import { SuggestionChips } from './SuggestionChips';

// First-run placeholder for the Thread — shown instead of an empty scroll area before any turn
// has run this session. Presentational only; the tap-to-fill dispatch lives wherever the caller
// wires `onSelect` (ChatPanel), matching SuggestionChips (CLAUDE.md "SolidJS + SRP").
export interface EmptyStateProps {
  onSelectSuggestion: (suggestion: Suggestion) => void;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <div class="dz-empty-state">
      <Icon name="agent" size="lg" class="dz-empty-state__icon" />
      <p class="dz-empty-state__title">Tell the agent what to build</p>
      <p class="dz-empty-state__subtitle">
        It edits this page live — pin an element with the picker for context, or start with one of
        these:
      </p>
      <SuggestionChips onSelect={props.onSelectSuggestion} />
    </div>
  );
}
