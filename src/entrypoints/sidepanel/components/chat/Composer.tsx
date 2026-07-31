import { createMemo, createSignal } from 'solid-js';
import { i18n } from '#i18n';
import { send as sendMessage, stopTurn, streaming } from '../../stores/chat';
import { pickerActive, selector, startPicker } from '../../stores/focus';
import { Icon } from '../Icon';
import './Composer.scss';
import { ContextChip } from './ContextChip';
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

  const canSend = createMemo(() => draft().trim().length > 0 && !streaming());
  const attachActive = createMemo(() => pickerActive() || selector() !== null);

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
    if (isSubmitKey(e)) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div class="dz-composer">
      <ContextChip />

      <div class="dz-composer__shell">
        {/* A placeholder is not an accessible name — it disappears the moment the field has
            content, leaving the textarea nameless mid-message. Visually hidden, so the shell
            still looks like Leo's. */}
        <label class="dz-composer__label" for={INPUT_ID}>
          {i18n.t('composer.input.ariaLabel')}
        </label>
        <textarea
          id={INPUT_ID}
          class="dz-composer__input"
          placeholder={i18n.t('composer.placeholder')}
          rows={1}
          value={draft()}
          aria-describedby={HINT_ID}
          aria-keyshortcuts="Enter"
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        {/* Deliberately NOT `disabled` while a turn streams: `disabled` drops the element from
            the tab order and blurs it, dumping focus on `<body>` mid-turn. The field stays
            editable so the next instruction can be drafted while the agent works; only the send
            affordance is gated (and it is the Stop button by then anyway). */}

        {/* Announced via aria-describedby — `aria-keyshortcuts` above is metadata with no
            behaviour and tells a user nothing on its own; this line is what does. */}
        <p id={HINT_ID} class="dz-composer__hint">
          {i18n.t('composer.hint.keyboard')}
        </p>

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
                the class is the documented way in (Icon.scss). */}
            <Icon name="picker" size="sm" class="dz-icon--fixed" />
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
            <Icon name={streaming() ? 'close' : 'arrowUp'} size="sm" class="dz-icon--fixed" />
          </button>
        </div>
      </div>
    </div>
  );
}
