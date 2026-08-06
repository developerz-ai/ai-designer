import { createMemo, createSignal } from 'solid-js';
import { i18n } from '#i18n';
import type { StableSelector } from '@/shared/messages';
import { send as sendMessage, stopTurn, streaming } from '../../stores/chat';
import {
  mentionReference,
  pickerActive,
  recentReferences,
  selector,
  startPicker,
} from '../../stores/focus';
import { Icon } from '../Icon';
import './Composer.scss';
import { ElementRefs } from './ElementRefs';
import { filterMentions, MentionMenu, mentionQuery } from './MentionMenu';
import { ModelPicker } from './ModelPicker';

// The message composer: one Leo-style shell (the container owns the border + focus treatment)
// holding a chrome-less textarea over a toolbar row — attach, model quick-switch, and a single
// circular send/stop affordance. Enter sends, Shift+Enter inserts a newline. Draft text is the
// only local state; everything else dispatches through a store, and the model menu lives in its
// own component (CLAUDE.md "SolidJS + SRP").

const INPUT_ID = 'dz-composer-input';
const HINT_ID = 'dz-composer-hint';

/** Enter submits; Shift+Enter inserts a newline, and so does every other modifier combo.
 *
 *  Three guards beyond the modifiers, all of them real defects when missing:
 *  - `isComposing` — the Enter that commits an IME candidate (Japanese/Chinese/Korean) fires a
 *    keydown like any other. Without this, the first Enter sends a half-composed message.
 *  - `repeat` — a held Enter autorepeats and would send once per repeat.
 *  - `ctrl/meta/alt` — Ctrl+Enter and Cmd+Enter are "send" in other apps, but here they used to
 *    submit while claiming in a comment not to.
 *
 *  Fields past `key`/`shiftKey` are optional so the predicate stays callable with a plain object
 *  (a real `KeyboardEvent`, whose fields are all required, is still assignable). Pure — unit
 *  tested without a DOM. */
export function isSubmitKey(e: {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}): boolean {
  return (
    e.key === 'Enter' &&
    !e.shiftKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.isComposing &&
    !e.repeat
  );
}

export function Composer() {
  const [draft, setDraft] = createSignal('');
  // An in-progress `@mention`: where it starts in the draft and what has been typed after it.
  // Null whenever the caret is not in one — see `mentionQuery` for why that rule is narrow.
  const [mention, setMention] = createSignal<{ start: number; query: string } | null>(null);
  const [activeMention, setActiveMention] = createSignal(0);
  let input: HTMLTextAreaElement | undefined;

  const mentionItems = createMemo(() => filterMentions(recentReferences(), mention()?.query ?? ''));
  const mentionOpen = createMemo(() => mention() !== null && mentionItems().length > 0);

  /** Re-derive the mention state from the field's live value + caret. Called on every input and
   *  on selection moves, because the caret can leave a mention without the text changing. */
  function syncMention(el: HTMLTextAreaElement): void {
    const next = mentionQuery(el.value, el.selectionStart);
    setMention(next);
    setActiveMention(0);
  }

  /** Replace the `@query` run with nothing and attach the element instead. The chip IS the
   *  reference — leaving `@Hero heading` in the prose would be a second, unauthoritative copy of
   *  the same fact, and the agent is grounded on the chip, not on the words. */
  function takeMention(sel: StableSelector): void {
    const at = mention();
    if (!at) return;
    const el = input;
    const text = draft();
    const caret = el ? el.selectionStart : at.start + at.query.length + 1;
    setDraft(text.slice(0, at.start) + text.slice(caret));
    setMention(null);
    void mentionReference(sel.value);
    // Focus never left the textarea (the row commits on mousedown), but the caret has to land
    // where the mention was or the next keystroke appends at the old offset.
    queueMicrotask(() => {
      el?.focus();
      el?.setSelectionRange(at.start, at.start);
    });
  }

  const canSend = createMemo(() => draft().trim().length > 0 && !streaming());
  // Lit only while the picker is ARMED. It used to stay lit for as long as anything was pinned,
  // which made an accent-filled button the resting state of the composer — and now that pinned
  // elements are chips sitting directly above, the button was saying the same thing twice.
  const attachActive = createMemo(() => pickerActive());

  function submit(): void {
    const text = draft();
    if (!text.trim() || streaming()) return;
    setDraft('');
    // The picked element is the whole point of the picker: without this third argument
    // "make this bigger" reaches the agent with no target and it guesses. `selector()` is the
    // focus store's live pin (ContextChip renders the same value); `undefined` when nothing is
    // pinned. Mode stays `undefined` — `agent/modes.ts` infers it from the text.
    void sendMessage(text, undefined, selector() ?? undefined);
  }

  function onKeyDown(e: KeyboardEvent): void {
    // The mention menu owns Up/Down/Enter/Escape while it is open — and ONLY while it is open,
    // so a composer with no recents behaves exactly as it did before.
    if (mentionOpen()) {
      const items = mentionItems();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActiveMention((i) => (i + step + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const pick = items[activeMention()];
        if (pick) takeMention(pick);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Closes the menu and LEAVES the literal `@` — the user may have meant the character.
        setMention(null);
        return;
      }
    }
    if (isSubmitKey(e)) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div class="dz-composer">
      <ElementRefs />

      <div class="dz-composer__shell" classList={{ 'dz-composer__shell--picking': attachActive() }}>
        {/* A placeholder is not an accessible name — it disappears the moment the field has
            content, leaving the textarea nameless mid-message. Visually hidden, so the shell
            still looks like Leo's. */}
        <label class="dz-composer__label" for={INPUT_ID}>
          {i18n.t('composer.input.ariaLabel')}
        </label>
        <MentionMenu
          items={recentReferences()}
          query={mention()?.query ?? ''}
          active={activeMention()}
          onPick={takeMention}
        />
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the rule resolves the textarea's
            IMPLICIT role and cannot see that `role` below becomes "combobox" under exactly the
            same condition — `aria-expanded` is only ever present while this IS a combobox. */}
        <textarea
          ref={input}
          id={INPUT_ID}
          class="dz-composer__input"
          placeholder={i18n.t('composer.placeholder')}
          rows={1}
          value={draft()}
          aria-describedby={HINT_ID}
          aria-keyshortcuts="Enter"
          // Combobox semantics, announced only while the popup exists — a textarea permanently
          // claiming `aria-expanded="false"` would tell every screen-reader user there is a
          // widget here even when there are no recents to offer.
          role={mentionOpen() ? 'combobox' : undefined}
          aria-expanded={mentionOpen() ? true : undefined}
          aria-controls={mentionOpen() ? 'dz-mention-list' : undefined}
          aria-activedescendant={mentionOpen() ? `dz-mention-${activeMention()}` : undefined}
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            syncMention(e.currentTarget);
          }}
          // The caret can leave a mention without the text changing (click, arrow keys), and a
          // menu that survives that is a menu that fires on the wrong run of text.
          onSelect={(e) => syncMention(e.currentTarget)}
          onBlur={() => setMention(null)}
          onKeyDown={onKeyDown}
        />
        {/* Deliberately NOT `disabled` while a turn streams: `disabled` drops the element from
            the tab order and blurs it, dumping focus on `<body>` mid-turn. The field stays
            editable so the next instruction can be drafted while the agent works; only the send
            affordance is gated (and it is the Stop button by then anyway). */}

        <div class="dz-composer__toolbar">
          <button
            type="button"
            class="dz-composer__attach"
            classList={{ 'is-active': attachActive() }}
            aria-pressed={attachActive()}
            // `title` alone yields a low-quality accessible name (WAI-ARIA APG) and is
            // unreachable without a pointing device. Kept for the tooltip; `aria-label` is the
            // actual name.
            aria-label={i18n.t('composer.attach.title')}
            title={i18n.t('composer.attach.title')}
            onClick={() => void startPicker()}
          >
            {/* `dz-icon--fixed`: absolute 16px, so a toolbar glyph doesn't scale with whatever
                font-size its container carries. Icon.tsx does not forward the `fixed` prop yet —
                the class is the documented way in (Icon.scss).
                A crosshair, not an arrow cursor: the same glyph the on-page rectangles are drawn
                around, so the button and its result are recognisably the same feature. */}
            <Icon name="target" size="sm" class="dz-icon--fixed" />
          </button>

          <ModelPicker />

          <div class="dz-composer__spacer" />

          {/* ONE slot, not two siblings: the same button changes identity, so there is exactly
              one tab stop here and it never moves. Two toggled buttons double the stops and make
              "which one am I on" ambiguous. The `Stop` name and the enclosing `.dz-composer`
              scope are load-bearing for e2e — the header's session toggle shares the name. */}
          <button
            type="button"
            class="dz-composer__action"
            classList={{ 'dz-composer__action--stop': streaming() }}
            aria-label={streaming() ? i18n.t('composer.stop') : i18n.t('composer.send.ariaLabel')}
            disabled={!streaming() && !canSend()}
            onClick={() => (streaming() ? void stopTurn() : submit())}
          >
            <Icon name={streaming() ? 'stop' : 'arrowUp'} size="sm" class="dz-icon--fixed" />
          </button>
        </div>
      </div>

      {/* Below the shell, and VISIBLE. It was inside the shell and visually hidden, which made
          it announced-only: Enter-sends is the one thing about this composer that surprises
          people, and it cost nothing to say it. Still the `aria-describedby` target, so a
          screen-reader user hears it exactly once, from here. */}
      <p id={HINT_ID} class="dz-composer__hint">
        {i18n.t('composer.hint.keyboard')}
      </p>
    </div>
  );
}
