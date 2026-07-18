import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { i18n } from '#i18n';
import {
  initOverlayStore,
  enabled as overlayEnabled,
  error as overlayError,
  setOverlayEnabled,
} from '../stores/overlay';
import {
  initReadinessStore,
  error as readinessError,
  loading as readinessLoading,
  state,
} from '../stores/readiness';
import {
  initSessionStore,
  type SessionState,
  error as sessionError,
  sessionState,
  startSession,
  stopSession,
} from '../stores/session';
import { Icon } from './Icon';
import type { IconName } from './icon-registry';
import './ReadinessDropdown.scss';

// Tabs a readiness check can deep-link to fix — a subset of App.tsx's `Tab` (chat is
// never a fix destination). Kept local + re-exported rather than importing `Tab` from
// App.tsx, which would create a cycle (App renders this component).
export type DeepLinkTab = 'settings' | 'mcp';

export interface ReadinessDropdownProps {
  onNavigate: (tab: DeepLinkTab) => void;
}

export type SessionAction = 'start' | 'stop';

/** The Start/Stop toggle's semantics for a given session state. `running` is the only state that
 *  Stops; `idle` (pre-Start) and `stopped` (Stop hit mid-turn — the session stays open) both
 *  (re)Start, so a stopped session is resumable rather than dead-ending on a no-op re-abort. Pure
 *  so the three-state mapping is unit-testable without mounting Solid. */
export function sessionButton(state: SessionState): { label: string; action: SessionAction } {
  return state === 'running'
    ? { label: i18n.t('readiness.button.stop'), action: 'stop' }
    : { label: i18n.t('readiness.button.start'), action: 'start' };
}

interface CheckRow {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
  tab: DeepLinkTab;
}

// Header status pill ("Leo"), the header's readiness dropdown. Collapsed reads
// "Ready"/"Setup needed"/"Running…" off the readiness + session stores (thin RPC+stream
// reflections of the SW's `computeReadiness`/`setSessionState` — see stores/readiness.ts,
// stores/session.ts); expanded lists one row per check with a deep-link to the tab that
// fixes it. The Start/Stop button is the only mutation this component dispatches — every
// other value here is a store read (CLAUDE.md "no business logic in components").
export function ReadinessDropdown(props: ReadinessDropdownProps) {
  const [open, setOpen] = createSignal(false);

  onMount(() => {
    initReadinessStore();
    initSessionStore();
    initOverlayStore();
  });

  const ready = createMemo(() => state()?.ready ?? false);
  const running = createMemo(() => sessionState() === 'running');

  const label = createMemo(() => {
    if (running()) return i18n.t('readiness.label.running');
    return ready() ? i18n.t('readiness.label.ready') : i18n.t('readiness.label.setupNeeded');
  });

  const pillIcon = createMemo<IconName>(() => {
    if (running()) return 'spinner';
    return ready() ? 'check' : 'warning';
  });

  const checks = createMemo<CheckRow[]>(() => {
    const s = state();
    if (!s) return [];
    return [
      {
        key: 'provider',
        label: i18n.t('readiness.check.provider'),
        ok: s.provider === 'ok',
        tab: 'settings',
      },
      {
        key: 'model',
        label: i18n.t('readiness.check.model'),
        ok: s.model === 'ok',
        tab: 'settings',
      },
      {
        key: 'hostPermission',
        label: i18n.t('readiness.check.hostPermission'),
        ok: s.hostPermission === 'granted',
        tab: 'settings',
      },
      {
        key: 'mcp',
        label: i18n.t('readiness.check.mcp'),
        ok: s.mcp.connected > 0,
        detail: i18n.t('readiness.check.mcpDetail', {
          connected: String(s.mcp.connected),
          total: String(s.mcp.total),
        }),
        tab: 'mcp',
      },
    ];
  });

  async function toggleSession(): Promise<void> {
    if (sessionButton(sessionState()).action === 'stop') await stopSession();
    else await startSession();
  }

  function navigate(tab: DeepLinkTab): void {
    setOpen(false);
    props.onNavigate(tab);
  }

  return (
    <div class="dz-readiness">
      <button
        type="button"
        class="dz-readiness__pill"
        classList={{ 'is-ready': ready() && !running(), 'is-running': running() }}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open()}
      >
        <Icon name={pillIcon()} size="sm" spin={running()} />
        <span>{label()}</span>
        <Icon name="chevronDown" size="sm" class="dz-readiness__chevron" />
      </button>

      <button
        type="button"
        class="dz-readiness__toggle"
        disabled={!running() && (!ready() || readinessLoading())}
        onClick={() => void toggleSession()}
      >
        {sessionButton(sessionState()).label}
      </button>

      <Show when={open()}>
        <div class="dz-readiness__panel">
          <For each={checks()}>
            {(check) => (
              <div class="dz-readiness__row">
                <Icon name={check.ok ? 'check' : 'warning'} size="sm" />
                <span class="dz-readiness__rowlabel">{check.label}</span>
                <Show when={check.detail}>
                  <small class="dz-readiness__rowdetail">{check.detail}</small>
                </Show>
                <Show when={!check.ok}>
                  <button
                    type="button"
                    class="dz-readiness__link"
                    onClick={() => navigate(check.tab)}
                  >
                    {i18n.t('readiness.fix')} <Icon name="externalLink" size="sm" />
                  </button>
                </Show>
              </div>
            )}
          </For>

          <div class="dz-readiness__row">
            <Icon name="eye" size="sm" />
            <span class="dz-readiness__rowlabel">{i18n.t('readiness.overlay.label')}</span>
            <button
              type="button"
              class="dz-readiness__link"
              role="switch"
              aria-checked={overlayEnabled()}
              onClick={() => void setOverlayEnabled(!overlayEnabled())}
            >
              {overlayEnabled() ? i18n.t('readiness.overlay.on') : i18n.t('readiness.overlay.off')}
            </button>
          </div>

          <Show when={sessionError() ?? readinessError() ?? overlayError()}>
            <p class="dz-readiness__error">
              <Icon name="warning" size="sm" />{' '}
              {sessionError() ?? readinessError() ?? overlayError()}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  );
}
