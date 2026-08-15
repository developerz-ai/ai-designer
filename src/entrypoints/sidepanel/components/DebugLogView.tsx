import { createMemo, createSignal, Match, onCleanup, Show, Switch } from 'solid-js';
import { i18n } from '#i18n';
import {
  type CopyOutcome,
  copyDebugLog,
  type FetchedLog,
  fetchDebugLog,
} from '../stores/debug-log';
import { Icon } from './Icon';
import './DebugLogView.scss';

// See the log, not just copy it — DebugLogCopy's sibling, mounted beside it in both homes
// (AboutSection and the ChatPanel error row). One press fetches the SAME rendered markdown the
// copy button puts on the clipboard (`stores/debug-log.ts` `fetchDebugLog` — one RPC shape for
// both paths) and shows it in a scrollable, selectable, monospace panel, so "what does the trace
// actually say" no longer requires pasting it somewhere else first.
//
// Dispatch only (CLAUDE.md "SolidJS + SRP"): the RPC and the clipboard write live in
// ../stores/debug-log. What IS here is view state that belongs to this one control — whether the
// viewer is open, the last fetch's outcome, the copy button's transient label — for the same
// reason DebugLogCopy holds its own label: a store signal would be a singleton shared across
// every mount.
//
// Presented as a modal overlay, the AuthDialog pattern (backdrop press or Escape closes, focus
// returns to the trigger): the two mount points sit in cramped columns where an inline expando
// would push the very error row it explains off-screen.

type LogView = { status: 'loading' } | { status: 'failed' } | ({ status: 'ready' } & FetchedLog);

type CopyState = 'idle' | 'copying' | CopyOutcome;

/** How long the copy confirmation shows before the button returns to its resting label. */
const COPY_RESET_MS = 2000;

export function DebugLogView() {
  const [open, setOpen] = createSignal(false);
  const [view, setView] = createSignal<LogView>({ status: 'loading' });
  const [copyState, setCopyState] = createSignal<CopyState>('idle');
  let invoker: HTMLElement | null = null;
  let dialogRef: HTMLDivElement | undefined;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => {
    if (copyTimer) clearTimeout(copyTimer);
  });

  async function load(): Promise<void> {
    setView({ status: 'loading' });
    const fetched = await fetchDebugLog();
    setView(fetched.ok ? { status: 'ready', ...fetched } : { status: 'failed' });
  }

  function show(): void {
    invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCopyState('idle');
    setOpen(true);
    void load();
    // Focus lands inside the dialog so Escape/Tab act on it, not on the row behind it.
    queueMicrotask(() => dialogRef?.focus());
  }

  function close(): void {
    setOpen(false);
    invoker?.focus();
    invoker = null;
  }

  async function copy(): Promise<void> {
    setCopyState('copying');
    const outcome = await copyDebugLog(); // the store's copy path — never reformatted here
    setCopyState(outcome);
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setCopyState('idle'), COPY_RESET_MS);
  }

  const copyLabel = createMemo(() => {
    switch (copyState()) {
      case 'copying':
        return i18n.t('about.debugLog.view.copying');
      case 'copied':
      case 'empty': // the visible text IS the log — "copied, but empty" is already on screen
        return i18n.t('about.debugLog.view.copied');
      case 'failed':
        return i18n.t('about.debugLog.view.copyFailed');
      default:
        return i18n.t('about.debugLog.view.copy');
    }
  });

  const ready = createMemo(() => {
    const v = view();
    return v.status === 'ready' ? v : undefined;
  });

  return (
    <>
      <button type="button" class="dz-debug-view__trigger" onClick={show}>
        <Icon name="eye" size="sm" class="dz-icon--fixed" />
        <span>{i18n.t('about.debugLog.view.open')}</span>
      </button>

      <Show when={open()}>
        <div class="dz-debug-view__backdrop">
          <button
            type="button"
            class="dz-debug-view__backdrop-dismiss"
            aria-label={i18n.t('about.debugLog.view.backdrop.ariaLabel')}
            onClick={close}
          />
          <div
            ref={dialogRef}
            class="dz-debug-view"
            role="dialog"
            aria-modal="true"
            aria-label={i18n.t('about.debugLog.view.title')}
            tabindex="-1"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
            }}
          >
            <header class="dz-debug-view__header">
              <strong>{i18n.t('about.debugLog.view.title')}</strong>
              {/* The SW's own entry count — the number that tells "no activity" apart from a real
                  trace without reading the markdown. Absent on a pre-`entries` reply. */}
              <Show when={ready()?.entries !== undefined}>
                <span class="dz-debug-view__count">
                  {i18n.t('about.debugLog.view.entries', ready()?.entries ?? 0)}
                </span>
              </Show>
              <span class="dz-debug-view__actions">
                <button
                  type="button"
                  class="dz-debug-view__action"
                  onClick={() => void load()}
                  disabled={view().status === 'loading'}
                >
                  <Icon name="redo" size="sm" class="dz-icon--fixed" />
                  {i18n.t('about.debugLog.view.refresh')}
                </button>
                <button
                  type="button"
                  class="dz-debug-view__action"
                  data-state={copyState()}
                  onClick={() => void copy()}
                  disabled={copyState() === 'copying'}
                >
                  <Icon name="copy" size="sm" class="dz-icon--fixed" />
                  <span aria-live="polite">{copyLabel()}</span>
                </button>
                <button
                  type="button"
                  class="dz-debug-view__close"
                  onClick={close}
                  aria-label={i18n.t('about.debugLog.view.close.ariaLabel')}
                >
                  <Icon name="close" size="sm" class="dz-icon--fixed" />
                </button>
              </span>
            </header>

            <Switch>
              <Match when={view().status === 'loading'}>
                <p class="dz-debug-view__hint">
                  <Icon name="spinner" size="sm" spin /> {i18n.t('about.debugLog.view.loading')}
                </p>
              </Match>
              <Match when={view().status === 'failed'}>
                <p class="dz-debug-view__hint is-error">
                  <Icon name="warning" size="sm" /> {i18n.t('about.debugLog.view.failed')}
                </p>
              </Match>
              {/* An empty log says so honestly instead of rendering a blank box — the header-only
                  markdown LOOKS like a trace at a glance, which is how "it logged nothing" hid. */}
              <Match when={ready()?.empty}>
                <p class="dz-debug-view__hint">{i18n.t('about.debugLog.view.empty')}</p>
              </Match>
              <Match when={ready()}>
                {(log) => <pre class="dz-debug-view__log">{log().markdown}</pre>}
              </Match>
            </Switch>
          </div>
        </div>
      </Show>
    </>
  );
}
