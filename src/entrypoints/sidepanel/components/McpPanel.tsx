import { createSignal, For, onMount, Show } from 'solid-js';
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
      <p class="dz-mcp__hint">Connect an implement backend. The agent ships changesets here.</p>

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
              {isAdded(preset) ? `${preset.label} added` : `Add ${preset.label}`}
            </button>
          )}
        </For>
      </section>

      <Show when={loading()}>
        <p class="dz-mcp__hint">
          <Icon name="spinner" size="sm" spin /> Loading servers…
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
                  <small class="dz-mcp__tools">{s.toolCount} tools</small>
                </Show>
                <Show when={s.status === 'error' && s.error}>
                  <small class="dz-mcp__errortext">{s.error}</small>
                </Show>
              </div>
              <div class="dz-mcp__actions">
                <Show when={s.status !== 'connected'}>
                  <button type="button" onClick={() => void connectServer(s.id)}>
                    Connect
                  </button>
                </Show>
                <Show when={s.authKind !== 'none'}>
                  <button type="button" class="dz-mcp__ghost" onClick={() => setAuthTarget(s)}>
                    Authorize
                  </button>
                </Show>
                <button
                  type="button"
                  class="dz-mcp__ghost"
                  aria-label={`Remove ${s.label}`}
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
          Add server
        </label>
        <input
          id="dz-mcp-label"
          type="text"
          placeholder="Label"
          value={label()}
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
        <input
          id="dz-mcp-url"
          type="url"
          placeholder="https://backend.example.com/mcp"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
        />
        <select
          id="dz-mcp-authkind"
          value={authKind()}
          onChange={(e) => setAuthKind(e.currentTarget.value as AuthKind)}
        >
          <option value="none">No auth</option>
          <option value="apikey">API key</option>
          <option value="oauth">OAuth</option>
        </select>
        <button type="submit">
          <Icon name="add" size="sm" /> Add
        </button>
      </form>

      <Show when={authTarget()}>
        {(s) => <AuthDialog server={s()} onClose={() => setAuthTarget(null)} />}
      </Show>
    </div>
  );
}
