import { createSignal, For, onMount, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { AuthKind, McpServer } from '@/shared/messages';
import {
  addServer,
  connectServer,
  error,
  hydrateMcp,
  initMcpStore,
  loading,
  removeServer,
  servers,
} from '../stores/mcp';
import { AuthDialog } from './AuthDialog';
import { Icon } from './Icon';
import type { IconName } from './icon-registry';
import './McpPanel.scss';

interface BackendPreset {
  id: string;
  label: string;
  url: string;
  authKind: AuthKind;
}

// Quick-add presets — the implement backends the agent ships changesets to
// (docs/idea/mcp.md). A registered server with the same id is skipped rather than
// duplicated (mcp-add always mints a fresh id, so re-clicking a preset after removal
// is fine; re-clicking while already connected just no-ops via the `alreadyAdded` guard).
const DEFAULT_BACKENDS: BackendPreset[] = [
  {
    id: 'ai-dev',
    label: 'Tesote AI Dev',
    url: 'https://ai-dev.miamibeachstart.com/mcp',
    authKind: 'apikey',
  },
  { id: 'developerz', label: 'developerz.ai', url: 'https://developerz.ai/mcp', authKind: 'oauth' },
];

function statusIcon(status: McpServer['status']): IconName {
  switch (status) {
    case 'connected':
      return 'check';
    case 'error':
      return 'warning';
    default:
      return 'status';
  }
}

// Render + dispatch only — every mutation (add/remove/connect/auth) is an RPC through
// ../stores/mcp, which reflects the SW's registry + mcp/manager.ts health (CLAUDE.md
// "SolidJS + SRP"). AuthDialog is mounted here (not inline) so only one is ever open.
export function McpPanel() {
  const [authTarget, setAuthTarget] = createSignal<McpServer | null>(null);
  const [label, setLabel] = createSignal('');
  const [url, setUrl] = createSignal('');
  const [authKind, setAuthKind] = createSignal<AuthKind>('none');

  onMount(() => {
    initMcpStore();
    void hydrateMcp();
  });

  function isAdded(preset: BackendPreset): boolean {
    return servers.some((s) => s.url === preset.url);
  }

  async function addPreset(preset: BackendPreset): Promise<void> {
    await addServer({ label: preset.label, url: preset.url, authKind: preset.authKind });
  }

  async function submitAdd(e: Event): Promise<void> {
    e.preventDefault();
    const l = label().trim();
    const u = url().trim();
    if (!l || !u) return;
    const ok = await addServer({ label: l, url: u, authKind: authKind() });
    if (ok) {
      setLabel('');
      setUrl('');
      setAuthKind('none');
    }
  }

  return (
    <div class="dz-mcp">
      <p class="dz-mcp__hint">{i18n.t('mcp.hint')}</p>

      <section class="dz-mcp__presets">
        <For each={DEFAULT_BACKENDS}>
          {(preset) => (
            <button
              type="button"
              class="dz-mcp__preset"
              disabled={isAdded(preset)}
              onClick={() => void addPreset(preset)}
            >
              <Icon name="mcp" size="sm" />
              {isAdded(preset)
                ? i18n.t('mcp.preset.added', { label: preset.label })
                : i18n.t('mcp.preset.add', { label: preset.label })}
            </button>
          )}
        </For>
      </section>

      <Show when={loading()}>
        <p class="dz-mcp__hint">
          <Icon name="spinner" size="sm" spin /> {i18n.t('mcp.loading')}
        </p>
      </Show>
      <Show when={error()}>
        <p class="dz-mcp__error">
          <Icon name="warning" size="sm" /> {error()}
        </p>
      </Show>

      <ul class="dz-mcp__list">
        <For each={servers}>
          {(s) => (
            <li class="dz-mcp__item">
              <span class={`dz-mcp__status is-${s.status}`}>
                <Icon name={statusIcon(s.status)} size="sm" />
              </span>
              <div class="dz-mcp__meta">
                <strong>{s.label}</strong>
                <small>{s.url}</small>
                <Show when={s.status === 'connected'}>
                  <small class="dz-mcp__tools">{i18n.t('mcp.server.toolCount', s.toolCount)}</small>
                </Show>
                <Show when={s.status === 'error' && s.error}>
                  <small class="dz-mcp__errortext">{s.error}</small>
                </Show>
              </div>
              <div class="dz-mcp__actions">
                <Show when={s.status !== 'connected'}>
                  <button type="button" onClick={() => void connectServer(s.id)}>
                    {i18n.t('mcp.server.connect')}
                  </button>
                </Show>
                <Show when={s.authKind !== 'none'}>
                  <button type="button" class="dz-mcp__ghost" onClick={() => setAuthTarget(s)}>
                    {i18n.t('mcp.server.authorize')}
                  </button>
                </Show>
                <button
                  type="button"
                  class="dz-mcp__ghost"
                  aria-label={i18n.t('mcp.server.remove.ariaLabel', { label: s.label })}
                  onClick={() => void removeServer(s.id)}
                >
                  <Icon name="trash" size="sm" />
                </button>
              </div>
            </li>
          )}
        </For>
      </ul>

      <form class="dz-mcp__add" onSubmit={submitAdd}>
        <label class="dz-mcp__label" for="dz-mcp-label">
          {i18n.t('mcp.add.label')}
        </label>
        <input
          id="dz-mcp-label"
          type="text"
          placeholder={i18n.t('mcp.add.labelPlaceholder')}
          value={label()}
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
        <input
          id="dz-mcp-url"
          type="url"
          placeholder={i18n.t('mcp.add.urlPlaceholder')}
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
        />
        <select
          id="dz-mcp-authkind"
          value={authKind()}
          onChange={(e) => setAuthKind(e.currentTarget.value as AuthKind)}
        >
          <option value="none">{i18n.t('mcp.add.authKind.none')}</option>
          <option value="apikey">{i18n.t('mcp.add.authKind.apikey')}</option>
          <option value="oauth">{i18n.t('mcp.add.authKind.oauth')}</option>
        </select>
        <button type="submit">
          <Icon name="add" size="sm" /> {i18n.t('mcp.add.submit')}
        </button>
      </form>

      <Show when={authTarget()}>
        {(s) => <AuthDialog server={s()} onClose={() => setAuthTarget(null)} />}
      </Show>
    </div>
  );
}
