import { createSignal, onCleanup } from 'solid-js';
import { i18n } from '#i18n';
import { type CopyOutcome, copyDebugLog } from '../stores/debug-log';
import { Icon } from './Icon';
import './DebugLogCopy.scss';

// One button: put this conversation's debug log on the clipboard.
//
// It sits beside "Report an issue" deliberately — the sequence a bug report actually takes is copy,
// then open the issue, then paste, and a control one click from the thing it feeds is the difference
// between a report with a trace and a report that says "it didn't work".
//
// Dispatch only (CLAUDE.md "SolidJS + SRP"): the RPC and the clipboard write live in
// ../stores/debug-log. What IS here is the transient label state, because it belongs to this one
// control — a signal in the store would be a singleton shared across every mount of the panel.
//
// `aria-live="polite"` on the label rather than a separate status node: the button's own text IS the
// confirmation, so a screen reader hears "Copied" from the control it just activated instead of from
// an announcement region elsewhere in the tree.

type CopyState = 'idle' | 'copying' | CopyOutcome;

/** How long the confirmation shows before the button returns to its resting label. */
const RESET_MS = 2000;

export function DebugLogCopy() {
  const [state, setState] = createSignal<CopyState>('idle');
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  // A panel closed mid-confirmation must not leave a timer that setStates a disposed signal.
  onCleanup(() => {
    if (resetTimer) clearTimeout(resetTimer);
  });

  async function copy(): Promise<void> {
    setState('copying');
    const outcome = await copyDebugLog();
    setState(outcome);
    // A second press while a confirmation is still showing restarts the window, rather than leaving
    // the earlier timer to clear the newer state early.
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => setState('idle'), RESET_MS);
  }

  const label = () => {
    switch (state()) {
      case 'copying':
        return i18n.t('about.debugLog.copying');
      case 'copied':
        return i18n.t('about.debugLog.copied');
      case 'empty':
        return i18n.t('about.debugLog.empty');
      case 'failed':
        return i18n.t('about.debugLog.failed');
      default:
        return i18n.t('about.debugLog.copy');
    }
  };

  return (
    <button
      type="button"
      class="dz-debug-log"
      data-state={state()}
      disabled={state() === 'copying'}
      onClick={() => void copy()}
    >
      <Icon name="bug" size="sm" class="dz-icon--fixed" />
      <span aria-live="polite">{label()}</span>
    </button>
  );
}
