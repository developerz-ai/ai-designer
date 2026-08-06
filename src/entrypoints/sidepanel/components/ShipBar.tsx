import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { i18n } from '#i18n';
import {
  changeset,
  downloadReport,
  error,
  fallbackReason,
  initChangesetStore,
  sendReport,
  ship,
  shipping,
} from '../stores/changeset';
import { hydrateMcp, initMcpStore, isNoRepoReason, loadOriginRepos, servers } from '../stores/mcp';
import { setTab } from '../stores/nav';
import { dismissOnOutsidePress } from './dismiss';
import { Icon } from './Icon';
import { OriginRepoSection } from './OriginRepoSection';
import './ShipBar.scss';

// Render + dispatch only (CLAUDE.md "SolidJS + SRP"): Ship / Download brief / Send to… each fire
// one RPC through ../stores/changeset, which owns the SW round-trip, the report-vs-tasks routing
// outcome, and the blob-URL download side effect. The connected-backend list for "Send to…" is
// read from ../stores/mcp (already the thin reflection of the SW's server registry) rather than
// duplicated here.
export function ShipBar() {
  const [sendOpen, setSendOpen] = createSignal(false);
  let sendEl: HTMLDivElement | undefined;

  onMount(() => {
    initChangesetStore();
    initMcpStore();
    void hydrateMcp();
    void loadOriginRepos();
  });

  // Same gap ModelPicker had: the "Send to…" menu stayed up until its own trigger was pressed
  // again. Both now light-dismiss through the shared helper.
  dismissOnOutsidePress(
    () => sendEl,
    sendOpen,
    () => setSendOpen(false),
  );

  const connected = createMemo(() => servers.filter((s) => s.status === 'connected'));
  const editCount = createMemo(() => changeset()?.edits.length ?? 0);
  // #20 one-click promise: a Ship that fell back because this origin has no repo mapped surfaces
  // the mapping form INLINE (not a dialog) — save once, then the same Ship goes to the backend.
  const noRepoFallback = createMemo(() => isNoRepoReason(fallbackReason()));

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
          {i18n.t('ship.button')}
        </button>

        {/* Icon-only, with a real accessible name. Three labelled buttons could not share one
            328px row without each of them truncating; Ship is the action anyone came here for,
            so it keeps its words and the two secondary actions become squares. */}
        <button
          type="button"
          class="dz-shipbar__ghost"
          disabled={shipping()}
          aria-label={i18n.t('ship.download')}
          title={i18n.t('ship.download')}
          onClick={() => void downloadReport()}
        >
          <Icon name="download" size="sm" class="dz-icon--fixed" />
        </button>

        <div class="dz-shipbar__send" ref={sendEl}>
          <button
            type="button"
            class="dz-shipbar__ghost"
            disabled={shipping() || connected().length === 0}
            aria-expanded={sendOpen()}
            aria-haspopup="menu"
            aria-label={i18n.t('ship.sendTo')}
            title={i18n.t('ship.sendTo')}
            onClick={() => setSendOpen((v) => !v)}
          >
            <Icon name="mcp" size="sm" class="dz-icon--fixed" />
            <Icon name="chevronDown" size="sm" class="dz-shipbar__caret" />
          </button>

          {/* Opens UPWARD. The ship bar is docked directly above the composer, so a downward
              menu covers the input the user is about to type into. */}
          <Show when={sendOpen()}>
            <ul class="dz-shipbar__menu">
              <li class="dz-shipbar__menuTitle">{i18n.t('ship.sendTo')}</li>
              <For each={connected()}>
                {(s) => (
                  <li>
                    <button type="button" onClick={() => void handleSend(s.id)}>
                      <span class="dz-shipbar__dot" />
                      <span class="dz-shipbar__menuLabel">{s.label}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>

        {/* The changeset is the one non-chat surface INSIDE the design loop, so it keeps a
            one-click entry even though the nav moved behind the wordmark. Docked here rather
            than under a turn: this row is pinned above the composer and always on screen,
            whereas an in-thread link is gone the moment the thread scrolls — and it answers
            "what would Ship ship?" adjacent to the button that ships it. */}
        <Show when={editCount() > 0}>
          <button type="button" class="dz-shipbar__edits" onClick={() => setTab('diff')}>
            <Icon name="check" size="sm" class="dz-icon--fixed" />
            <span>{i18n.t('diff.count', editCount())}</span>
            <Icon name="chevronRight" size="sm" class="dz-icon--fixed" />
          </button>
        </Show>
      </div>

      <Show when={fallbackReason()}>
        <p class="dz-shipbar__hint">
          <Icon name="status" size="sm" />{' '}
          {i18n.t('ship.fallback', { reason: fallbackReason() ?? '' })}
        </p>
      </Show>
      <Show when={noRepoFallback()}>
        <div class="dz-shipbar__map">
          <p class="dz-shipbar__mapHint">{i18n.t('ship.mapPrompt')}</p>
          <OriginRepoSection
            compact
            submitLabel={i18n.t('ship.mapAndShip')}
            onSaved={() => void ship()}
          />
        </div>
      </Show>
      <Show when={error()}>
        <p class="dz-shipbar__error">
          <Icon name="warning" size="sm" /> {error()}
        </p>
      </Show>
    </div>
  );
}
