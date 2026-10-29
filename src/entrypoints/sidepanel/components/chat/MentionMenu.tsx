import { createMemo, For, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { StableSelector } from '@/shared/messages';
import { Icon } from '../Icon';
import { humanName } from './ContextChip';
import './MentionMenu.scss';

// The `@` menu (#175): reference an element without leaving the keyboard. It lists what has been
// pinned this session (`stores/focus`'s recents), because the alternative — listing what is
// CURRENTLY attached — offers only the set the user has no reason to attach again. The most
// likely reason to open this is "I removed that chip by mistake".
//
// Presentational + dispatch only (CLAUDE.md "SolidJS + SRP"): Composer owns the trigger detection
// and the textarea surgery; the store owns what attaching means.

/** Where an in-progress `@mention` starts in `text`, and what has been typed after it — or null
 *  if the caret is not in one. Pure, so the trigger rule is unit-testable without a DOM.
 *
 *  The rule is deliberately narrow: the `@` must open a word (start of text or after whitespace),
 *  and the query may not contain whitespace. Without the word-boundary test every email address
 *  and every `user@host` opens a menu mid-typing; without the whitespace test the menu stays open
 *  across a whole sentence once one `@` has been typed. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  const prev = at === 0 ? '' : (before[at - 1] ?? '');
  if (prev !== '' && !/\s/.test(prev)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** Case-insensitive match against the human name AND the raw selector, so both "hero" and
 *  ".hero > h1" find the same row. Pure. */
export function filterMentions(items: StableSelector[], query: string): StableSelector[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (sel) => humanName(sel).toLowerCase().includes(q) || sel.value.toLowerCase().includes(q),
  );
}

export interface MentionMenuProps {
  /** Recently pinned elements, newest first. */
  items: StableSelector[];
  /** What has been typed after the `@`. */
  query: string;
  /** Index of the row Enter would take. Owned by Composer, which also owns the arrow keys. */
  active: number;
  /** True while the menu is animating out — Composer keeps it mounted for that window. */
  leaving?: boolean;
  onPick: (sel: StableSelector) => void;
}

export function MentionMenu(props: MentionMenuProps) {
  const shown = createMemo(() => filterMentions(props.items, props.query));

  return (
    <Show when={shown().length > 0}>
      {/* A listbox, not a menu: it is a filtered set of choices for the textarea that keeps
          focus, which is exactly the combobox popup role. Focus never moves here — Composer
          drives the active row with aria-activedescendant, so typing keeps working. */}
      {/* Plain `div`s, not `ul`/`li`: an option in an activedescendant listbox is not a link or
          a button and must not be a tab stop, and wrapping a real `<button>` in a `role="option"`
          gives the row two conflicting semantics. */}
      <div
        class="dz-mention"
        classList={{ 'is-leaving': props.leaving }}
        id="dz-mention-list"
        role="listbox"
        aria-label={i18n.t('mention.ariaLabel')}
      >
        <For each={shown()}>
          {(sel, i) => (
            /* `onMouseDown`, not `onClick`: a click blurs the textarea first, which closes the
               menu and drops the selection before the handler would ever run.

               The suppression below: the rule wants a non-negative tabindex on `role="option"`,
               which is right for a focus-following listbox and wrong for this one. Focus stays in
               the textarea and the active option is named by `aria-activedescendant` (WAI-ARIA
               APG, combobox with listbox popup); tab stops here would put five extra stops
               between typing a message and sending it. */
            // biome-ignore lint/a11y/useFocusableInteractive: activedescendant listbox — see above
            <div
              id={`dz-mention-${i()}`}
              class="dz-mention__row"
              classList={{ 'is-active': i() === props.active }}
              role="option"
              tabindex="-1"
              aria-selected={i() === props.active}
              onMouseDown={(e) => {
                e.preventDefault();
                props.onPick(sel);
              }}
            >
              <Icon name="target" size="sm" class="dz-icon--fixed" />
              <span class="dz-mention__name">{humanName(sel)}</span>
              <span class="dz-mention__selector">{sel.value}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
