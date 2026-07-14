import { createSignal, For, onMount, Show } from 'solid-js';
import {
  downloadReport,
  error,
  fallbackReason,
  initChangesetStore,
  sendReport,
  ship,
  shipping,
} from '../stores/changeset';
import { hydrateMcp, initMcpStore, servers } from '../stores/mcp';
import { Icon } from './Icon';
import './ShipBar.scss';

// Render + dispatch only (CLAUDE.md "SolidJS + SRP"): Ship / Download brief / Send to… each fire
// one RPC through ../stores/changeset, which owns the SW round-trip, the report-vs-tasks routing
// outcome, and the blob-URL download side effect. The connected-backend list for "Send to…" is
// read from ../stores/mcp (already the thin reflection of the SW's server registry) rather than
// duplicated here.
export function ShipBar() {
  const [sendOpen, setSendOpen] = createSignal(false);

  onMount(() => {
    initChangesetStore();
    initMcpStore();
    void hydrateMcp();
  });

  const connected = () => servers.filter((s) => s.status === 'connected');

  async function handleSend(target: string): Promise<void> {
    setSendOpen(false);
    await sendReport(target);
  }

  return (
    <div class="dz-shipbar">
      <div class="dz-shipbar__actions">
        <button
          type="button"
          class="dz-shipbar__primary"
          disabled={shipping()}
          onClick={() => void ship()}
        >
          <Icon name={shipping() ? 'spinner' : 'ship'} size="sm" spin={shipping()} />
          Ship
        </button>

        <button
          type="button"
          class="dz-shipbar__ghost"
          disabled={shipping()}
          onClick={() => void downloadReport()}
        >
          <Icon name="download" size="sm" />
          Download brief
        </button>

        <div class="dz-shipbar__send">
          <button
            type="button"
            class="dz-shipbar__ghost"
            disabled={shipping() || connected().length === 0}
            aria-expanded={sendOpen()}
            onClick={() => setSendOpen((v) => !v)}
          >
            <Icon name="send" size="sm" />
            Send to…
            <Icon name="chevronDown" size="sm" />
          </button>

          <Show when={sendOpen()}>
            <ul class="dz-shipbar__menu">
              <For each={connected()}>
                {(s) => (
                  <li>
                    <button type="button" onClick={() => void handleSend(s.id)}>
                      {s.label}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>

      <Show when={fallbackReason()}>
        <p class="dz-shipbar__hint">
          <Icon name="status" size="sm" /> {fallbackReason()} — downloaded a brief instead.
        </p>
      </Show>
      <Show when={error()}>
        <p class="dz-shipbar__error">
          <Icon name="warning" size="sm" /> {error()}
        </p>
      </Show>
    </div>
  );
}
