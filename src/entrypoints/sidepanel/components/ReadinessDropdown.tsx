import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import {
  initReadinessStore,
  error as readinessError,
  loading as readinessLoading,
  state,
} from '../stores/readiness';
import {
  initSessionStore,
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
  });

  const ready = createMemo(() => state()?.ready ?? false);
  const running = createMemo(() => sessionState() === 'running');

  const label = createMemo(() => {
    if (running()) return 'Running…';
    return ready() ? 'Ready' : 'Setup needed';
  });

  const pillIcon = createMemo<IconName>(() => {
    if (running()) return 'spinner';
    return ready() ? 'check' : 'warning';
  });

  const checks = createMemo<CheckRow[]>(() => {
    const s = state();
    if (!s) return [];
    return [
      { key: 'provider', label: 'Provider', ok: s.provider === 'ok', tab: 'settings' },
      { key: 'model', label: 'Model', ok: s.model === 'ok', tab: 'settings' },
      {
        key: 'hostPermission',
        label: 'Host permission',
        ok: s.hostPermission === 'granted',
        tab: 'settings',
      },
      {
        key: 'mcp',
        label: 'MCP backend',
        ok: s.mcp.connected > 0,
        detail: `${s.mcp.connected}/${s.mcp.total} connected`,
        tab: 'mcp',
      },
    ];
  });

  async function toggleSession(): Promise<void> {
    if (sessionState() === 'idle') await startSession();
    else await stopSession();
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
        disabled={sessionState() === 'idle' && (!ready() || readinessLoading())}
        onClick={() => void toggleSession()}
      >
        {sessionState() === 'idle' ? 'Start' : 'Stop'}
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
                    Fix <Icon name="externalLink" size="sm" />
                  </button>
                </Show>
              </div>
            )}
          </For>
          <Show when={sessionError() ?? readinessError()}>
            <p class="dz-readiness__error">
              <Icon name="warning" size="sm" /> {sessionError() ?? readinessError()}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  );
}
