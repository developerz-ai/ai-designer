import { createSignal, onCleanup } from 'solid-js';
import { i18n } from '#i18n';
import { newConversation, streaming } from '../../stores/chat';
import { Icon } from '../Icon';
import './NewConversation.scss';

// The chat toolbar's "New conversation" — archive this thread to History and start fresh on the
// same tab, keeping the page's live edits and the changeset.
//
// Dispatch only (CLAUDE.md "SolidJS + SRP"): the RPC + transcript reset live in
// ../../stores/chat.ts `newConversation`. What IS here is the ARM state, because it belongs to
// this one control — the same two-press pattern as the Diff tab's "Clear session? Sure"
// (ChangesetPreview): the first press re-labels the button to say what a second press does, the
// second press acts, and the arm disarms itself after a beat. That covers the destructive case
// without a modal: while a turn is streaming the armed label says outright that it stops the
// current turn, so the confirmation carries the consequence instead of hiding it behind a
// tooltip. `aria-live` on the label so a screen reader hears the re-label from the control it
// just pressed (the DebugLogCopy convention).

/** How long the armed confirmation waits for the second press before disarming. */
const ARM_RESET_MS = 4000;

export function NewConversation() {
  const [armed, setArmed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let disarmTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => {
    if (disarmTimer) clearTimeout(disarmTimer);
  });

  async function press(): Promise<void> {
    if (busy()) return;
    if (!armed()) {
      setArmed(true);
      if (disarmTimer) clearTimeout(disarmTimer);
      disarmTimer = setTimeout(() => setArmed(false), ARM_RESET_MS);
      return;
    }
    if (disarmTimer) clearTimeout(disarmTimer);
    setArmed(false);
    setBusy(true);
    await newConversation(); // a refusal surfaces on the store's error() notice
    setBusy(false);
  }

  const label = () =>
    armed()
      ? streaming()
        ? i18n.t('chat.newConversation.confirmStreaming')
        : i18n.t('chat.newConversation.confirm')
      : i18n.t('chat.newConversation.label');

  return (
    <button
      type="button"
      class="dz-newconv"
      data-armed={armed()}
      disabled={busy()}
      onClick={() => void press()}
    >
      <Icon name="add" size="sm" class="dz-icon--fixed" />
      <span aria-live="polite">{label()}</span>
    </button>
  );
}
