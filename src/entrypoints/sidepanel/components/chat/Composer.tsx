import { createMemo, createSignal, Show } from 'solid-js';
import { i18n } from '#i18n';
import { ATTACHMENT_IMAGE_TYPES, isSupportedImageType } from '@/shared/attachments';
import type { StableSelector } from '@/shared/messages';
import {
  addBigPaste,
  addFiles,
  attachments,
  clearAttachments,
  isBigPaste,
} from '../../stores/attachments';
import { send as sendMessage, stopTurn, streaming } from '../../stores/chat';
import {
  disarmPicker,
  mentionReference,
  pickerActive,
  recentReferences,
  selector,
  startPicker,
} from '../../stores/focus';
import { Icon } from '../Icon';
import { AttachmentTray } from './AttachmentTray';
import './Composer.scss';
import { createPresence } from '../presence';
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

/**
 * What a send carries when the user attached reference material and typed nothing. "Here, match
 * this" with a mockup and no words is a real message, so the send button unlocks on an attachment
 * alone — but the service worker would then receive an empty instruction and the model would be
 * asked to act on nothing, so the composer supplies the obvious one instead.
 *
 * Deliberately NOT in `en.yml`: this is not UI copy, it is the instruction handed to the model,
 * and model-facing prompt text lives in code throughout this repo (`agent/vision.ts`,
 * `agent/system-prompt.ts`).
 */
export const ATTACHMENT_ONLY_TEXT = 'Use the attached reference material.';

/** Clipboard/DataTransfer surface this component reads. Structural, so a unit test can hand it a
 *  plain object — jsdom has no real `DataTransfer`. */
export interface TransferLike {
  files?: ArrayLike<File> | null;
  types?: ArrayLike<string> | null;
  getData?(type: string): string;
}

/** Image files on a clipboard, and only images. Filtered rather than reported: a paste normally
 *  carries several flavours of the SAME thing (text/plain + text/html + an image), so complaining
 *  about the non-image members would fire on every ordinary paste. */
export function clipboardImages(data: TransferLike | null | undefined): File[] {
  return transferFiles(data).filter((f) => isSupportedImageType(f.type));
}

/** Everything a drop or the file picker handed over — UNFILTERED on purpose, the opposite choice
 *  to `clipboardImages`. Dropping a PDF is a deliberate act, so the store gets to say "that is not
 *  an image" out loud rather than swallowing it. */
export function transferFiles(data: TransferLike | null | undefined): File[] {
  const files = data?.files;
  return files ? Array.from(files) : [];
}

/** Whether a drag carries files at all. `dataTransfer.files` is EMPTY during `dragover` (the
 *  browser withholds the bytes until the drop), so the only thing to test at that point is the
 *  advertised type list — checking `files` there means the drop target never lights up. */
export function isFileDrag(data: TransferLike | null | undefined): boolean {
  const types = data?.types;
  return types ? Array.from(types).includes('Files') : false;
}

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
  // A file is being dragged over the composer. Local view state — nothing outside this shell has
  // any use for it.
  const [dropping, setDropping] = createSignal(false);
  let input: HTMLTextAreaElement | undefined;
  let fileInput: HTMLInputElement | undefined;

  const mentionItems = createMemo(() => filterMentions(recentReferences(), mention()?.query ?? ''));
  const mentionOpen = createMemo(() => mention() !== null && mentionItems().length > 0);
  const mentionPresence = createPresence(mentionOpen);

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

  // An attachment ALONE is enough to send: a mockup with no words is a complete instruction in
  // this product ("match this"), and requiring a sentence would make the feature feel like a
  // second-class add-on to the text field. The empty instruction that would otherwise reach the
  // SW is filled in by `ATTACHMENT_ONLY_TEXT` in `submit()`.
  const canSend = createMemo(
    () => (draft().trim().length > 0 || attachments().length > 0) && !streaming(),
  );
  // Lit only while the picker is ARMED. It used to stay lit for as long as anything was pinned,
  // which made an accent-filled button the resting state of the composer — and now that pinned
  // elements are chips sitting directly above, the button was saying the same thing twice.
  const attachActive = createMemo(() => pickerActive());

  async function submit(): Promise<void> {
    const trimmed = draft().trim();
    const attached = attachments();
    if ((!trimmed && attached.length === 0) || streaming()) return;
    setDraft('');
    // The picked element is the whole point of the picker: without this third argument
    // "make this bigger" reaches the agent with no target and it guesses. `selector()` is the
    // focus store's live pin (ContextChip renders the same value); `undefined` when nothing is
    // pinned. Mode stays `undefined` — `agent/modes.ts` infers it from the text.
    const accepted = await sendMessage(
      trimmed || ATTACHMENT_ONLY_TEXT,
      undefined,
      selector() ?? undefined,
      attached.length > 0 ? attached : undefined,
    );
    // ONLY on success. A rejected send (a restarting worker, a turn already in flight) used to
    // cost nothing; now it would cost the user six re-picked files, so the tray outlives it and
    // the same Send press works again.
    if (accepted) clearAttachments();
  }

  /** Three ways in, one of them destructive if it is got wrong: pasting a stylesheet into a
   *  one-row textarea destroys the composer. Images become attachments, a big paste becomes a
   *  named text attachment, and everything shorter is left ALONE — an ordinary paste must behave
   *  exactly as it did before this feature existed. */
  function onPaste(e: ClipboardEvent): void {
    const data = e.clipboardData as TransferLike | null;
    if (!data) return;
    const images = clipboardImages(data);
    if (images.length > 0) {
      e.preventDefault();
      void addFiles(images);
      return;
    }
    const text = data.getData?.('text/plain') ?? '';
    if (isBigPaste(text)) {
      e.preventDefault();
      addBigPaste(text);
    }
  }

  function onDrop(e: DragEvent): void {
    if (!isFileDrag(e.dataTransfer as TransferLike | null)) return;
    // Both halves matter: without `preventDefault` here (and on `dragover`) the panel NAVIGATES
    // to the dropped file and the whole side panel is gone.
    e.preventDefault();
    setDropping(false);
    const files = transferFiles(e.dataTransfer as TransferLike | null);
    if (files.length > 0) void addFiles(files);
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
      void submit();
    }
  }

  return (
    // Drag handling sits on the whole composer, not on the textarea: the target a user aims at is
    // the box, and a drop that lands 4px outside the field would otherwise navigate the panel away.
    // A drop target is not a widget and there is no ARIA role that fits one: `role="button"` here
    // would announce a control that does nothing on Enter. Drag-and-drop is pointer-only by
    // nature, so the KEYBOARD-reachable equivalent is the "Attach an image" button in the toolbar
    // below — a real control with a real name. Nothing is reachable only by dragging.
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only drop target, see above
    <div
      class="dz-composer"
      onDragOver={(e) => {
        if (!isFileDrag(e.dataTransfer as TransferLike | null)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      // `dragleave` fires when the pointer crosses into a CHILD, so an unguarded handler makes the
      // drop state flicker off the moment the cursor reaches the textarea.
      onDragLeave={(e) => {
        const next = e.relatedTarget;
        if (!(next instanceof Node) || !e.currentTarget.contains(next)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      <ElementRefs />
      <AttachmentTray />

      <div
        class="dz-composer__shell"
        classList={{
          'dz-composer__shell--picking': attachActive(),
          'dz-composer__shell--dropping': dropping(),
        }}
      >
        {/* A placeholder is not an accessible name — it disappears the moment the field has
            content, leaving the textarea nameless mid-message. Visually hidden, so the shell
            still looks like Leo's. */}
        <label class="dz-composer__label" for={INPUT_ID}>
          {i18n.t('composer.input.ariaLabel')}
        </label>
        {/* Gated on `mentionOpen()`, not merely on having items: MentionMenu renders whenever
            its filtered list is non-empty, and an empty query matches everything — so once
            anything had been pinned this session the listbox sat permanently above the composer,
            with no combobox state on the textarea and no keys wired to it. */}
        <Show when={mentionPresence.mounted()}>
          <MentionMenu
            items={recentReferences()}
            query={mention()?.query ?? ''}
            active={activeMention()}
            leaving={mentionPresence.leaving()}
            onPick={takeMention}
          />
        </Show>
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
          onPaste={onPaste}
        />
        {/* Deliberately NOT `disabled` while a turn streams: `disabled` drops the element from
            the tab order and blurs it, dumping focus on `<body>` mid-turn. The field stays
            editable so the next instruction can be drafted while the agent works; only the send
            affordance is gated (and it is the Stop button by then anyway). */}

        <div class="dz-composer__toolbar">
          <button
            type="button"
            class="dz-composer__attach dz-composer__attach--element"
            classList={{ 'is-active': attachActive() }}
            aria-pressed={attachActive()}
            // `title` alone yields a low-quality accessible name (WAI-ARIA APG) and is
            // unreachable without a pointing device. Kept for the tooltip; `aria-label` is the
            // actual name.
            aria-label={i18n.t('composer.attach.title')}
            title={i18n.t('composer.attach.title')}
            // A real toggle, in both directions. It has always RENDERED as one — `aria-pressed`
            // and `.is-active` both track `pickerActive()` — while only ever arming, so a user
            // (and a screen reader) was told "pressed" about a control that could not be
            // un-pressed. Disarm keeps the references: pressing the crosshair off is not "clear
            // what I attached" (that is ElementRefs' Clear, which is `stopPicker`).
            onClick={() => void (attachActive() ? disarmPicker() : startPicker())}
          >
            {/* `dz-icon--fixed`: absolute 16px, so a toolbar glyph doesn't scale with whatever
                font-size its container carries. Icon.tsx does not forward the `fixed` prop yet —
                the class is the documented way in (Icon.scss).
                A crosshair, not an arrow cursor: the same glyph the on-page rectangles are drawn
                around, so the button and its result are recognisably the same feature. */}
            <Icon name="target" size="sm" class="dz-icon--fixed" />
          </button>

          {/* The SECOND attach affordance, and deliberately not a repurposing of the first: that
              one points at the page, this one brings a file to it. The BUTTON is the accessible
              control — a bare file input cannot be named, styled or reached the way the rest of
              this toolbar is. Reaching for the input's own `.click()` is the conventional (and
              only) way to drive it; it is dispatch, not rendering logic. */}
          {/* Shares `__attach`'s look, but carries its OWN modifier: two toolbar buttons
              distinguishable only by their accessible name made `.dz-composer__attach` ambiguous
              and broke an e2e pick (strict-mode violation, two matches). A shared base for the
              styling, a modifier for the identity. */}
          <button
            type="button"
            class="dz-composer__attach dz-composer__attach--file"
            aria-label={i18n.t('composer.attachFile.title')}
            title={i18n.t('composer.attachFile.title')}
            onClick={() => fileInput?.click()}
          >
            <Icon name="image" size="sm" class="dz-icon--fixed" />
          </button>
          <input
            ref={fileInput}
            class="dz-composer__file"
            type="file"
            multiple
            accept={ATTACHMENT_IMAGE_TYPES.join(',')}
            onChange={(e) => {
              const picked = e.currentTarget.files;
              if (picked) void addFiles(Array.from(picked));
              // Reset, or picking the SAME file twice in a row fires no second change event.
              e.currentTarget.value = '';
            }}
          />

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
      {/* Doubles as the drop hint while a file is over the composer: one line that swaps its
          text, rather than a second element appearing and shoving the composer up mid-drag. */}
      <p id={HINT_ID} class="dz-composer__hint">
        {dropping() ? i18n.t('composer.drop.hint') : i18n.t('composer.hint.keyboard')}
      </p>
    </div>
  );
}
