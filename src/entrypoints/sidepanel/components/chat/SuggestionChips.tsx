import { For } from 'solid-js';
import type { Mode } from '@/shared/messages';
import './SuggestionChips.scss';

// Quick-start task chips (Cursor/Leo-style) — one tap fills a common first instruction instead of
// typing it. Shown by EmptyState before any turn has run; a caller (ChatPanel) decides what a tap
// does (send immediately vs. prefill the Composer) via `onSelect`, so this stays presentational +
// dispatch-only (CLAUDE.md "SolidJS + SRP"). `mode` is a hint for `send()`'s optional `Mode` param
// — undefined lets `agent/modes.ts`'s `inferMode` read it off the prompt text instead.
export interface Suggestion {
  label: string;
  prompt: string;
  mode?: Mode;
}

export const SUGGESTIONS: Suggestion[] = [
  {
    label: "Copy nvidia's hero",
    prompt: "Copy nvidia.com's hero section onto this page.",
    mode: 'copy',
  },
  {
    label: 'Debug this filter',
    prompt: 'This filter looks broken — debug and fix it.',
    mode: 'debug',
  },
  { label: 'Ship to developerz.ai', prompt: 'Ship my accepted edits to developerz.ai as a PR.' },
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
              class="dz-suggestion-chips__chip"
              onClick={() => props.onSelect(s)}
            >
              {s.label}
            </button>
          </li>
        )}
      </For>
    </ul>
  );
}
