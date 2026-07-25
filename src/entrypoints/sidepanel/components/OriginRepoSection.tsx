import { createEffect, createMemo, createSignal, For, onMount, Show, untrack } from 'solid-js';
import { i18n } from '#i18n';
import type { OriginRepoEntry } from '@/shared/messages';
import {
  activeOrigin,
  loadOriginRepos,
  originRepos,
  removeOriginRepo,
  saveOriginRepo,
  servers,
} from '../stores/mcp';
import { Icon } from './Icon';
import './OriginRepoSection.scss';

// Origin → repo routing map (#20): which repo a page's Ship dispatches to, with an optional
// backend pin + base branch. Render + dispatch only (CLAUDE.md "SolidJS + SRP") — every mutation
// rides an RPC through ../stores/mcp. The form edits the CURRENT design tab's origin
// (stores/mcp.ts `activeOrigin`), pre-filled from its saved entry; the list shows the whole map.
// `compact` is ShipBar's inline no-repo affordance: the same form without the map list.
interface OriginRepoSectionProps {
  /** Form only, no map list (ShipBar's inline affordance). */
  compact?: boolean;
  /** Submit-label override (ShipBar's "Save mapping & Ship again"). */
  submitLabel?: string;
  /** Fired after a successful save — ShipBar re-fires ship(). */
  onSaved?: () => void;
}

export function OriginRepoSection(props: OriginRepoSectionProps) {
  const [repo, setRepo] = createSignal('');
  const [backendId, setBackendId] = createSignal('');
  const [branch, setBranch] = createSignal('');
  const [saving, setSaving] = createSignal(false);

  onMount(() => void loadOriginRepos());

  const entries = createMemo(() =>
    Object.entries(originRepos()).sort(([a], [b]) => a.localeCompare(b)),
  );
  const currentEntry = createMemo(() => {
    const origin = activeOrigin();
    return origin ? originRepos()[origin] : undefined;
  });

  // Pre-fill from the saved entry when the ACTIVE ORIGIN changes (first resolve / tab switch).
  // The entry read is untracked: a background map reload (or this form's own save) must never
  // clobber in-flight typing — only a change of page re-derives the form.
  createEffect(() => {
    activeOrigin();
    const entry = untrack(currentEntry);
    setRepo(entry?.repo ?? '');
    setBackendId(entry?.backendId ?? '');
    setBranch(entry?.branch ?? '');
  });

  function backendLabel(id: string): string {
    return servers.find((s) => s.id === id)?.label ?? id;
  }

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    const origin = activeOrigin();
    const slug = repo().trim();
    if (!origin || !slug || saving()) return;
    setSaving(true);
    try {
      const entry: OriginRepoEntry = {
        repo: slug,
        ...(backendId() ? { backendId: backendId() } : {}),
        ...(branch().trim() ? { branch: branch().trim() } : {}),
      };
      const ok = await saveOriginRepo(origin, entry);
      if (ok) props.onSaved?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section class="dz-originrepo" classList={{ 'dz-originrepo--compact': props.compact === true }}>
      <Show when={!props.compact}>
        <h3 class="dz-originrepo__title">{i18n.t('mcp.originRepo.title')}</h3>
        <Show when={entries().length === 0}>
          <p class="dz-originrepo__hint">{i18n.t('mcp.originRepo.empty')}</p>
        </Show>
        <ul class="dz-originrepo__list">
          <For each={entries()}>
            {([origin, entry]) => (
              <li class="dz-originrepo__row">
                <div class="dz-originrepo__meta">
                  <strong>{origin}</strong>
                  <small>
                    {entry.repo}
                    <Show when={entry.backendId}>{(id) => ` · ${backendLabel(id())}`}</Show>
                    <Show when={entry.branch}>{(b) => ` · ${b()}`}</Show>
                  </small>
                </div>
                <button
                  type="button"
                  class="dz-originrepo__remove"
                  aria-label={i18n.t('mcp.originRepo.remove.ariaLabel', { origin })}
                  onClick={() => void removeOriginRepo(origin)}
                >
                  <Icon name="trash" size="sm" />
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show
        when={activeOrigin()}
        fallback={<p class="dz-originrepo__hint">{i18n.t('mcp.originRepo.noActivePage')}</p>}
      >
        {(origin) => (
          <form class="dz-originrepo__form" onSubmit={submit}>
            <span class="dz-originrepo__origin">{origin()}</span>
            <input
              class="dz-originrepo__repo"
              type="text"
              required
              aria-label={i18n.t('mcp.originRepo.repo.label')}
              placeholder={i18n.t('mcp.originRepo.repo.placeholder')}
              value={repo()}
              onInput={(e) => setRepo(e.currentTarget.value)}
            />
            <select
              class="dz-originrepo__backend"
              aria-label={i18n.t('mcp.originRepo.backend.label')}
              value={backendId()}
              onChange={(e) => setBackendId(e.currentTarget.value)}
            >
              <option value="">{i18n.t('mcp.originRepo.backend.any')}</option>
              <For each={servers}>{(s) => <option value={s.id}>{s.label}</option>}</For>
            </select>
            <input
              class="dz-originrepo__branch"
              type="text"
              aria-label={i18n.t('mcp.originRepo.branch.label')}
              placeholder={i18n.t('mcp.originRepo.branch.placeholder')}
              value={branch()}
              onInput={(e) => setBranch(e.currentTarget.value)}
            />
            <button type="submit" disabled={saving() || !repo().trim()}>
              {props.submitLabel ?? i18n.t('mcp.originRepo.save')}
            </button>
          </form>
        )}
      </Show>
    </section>
  );
}
