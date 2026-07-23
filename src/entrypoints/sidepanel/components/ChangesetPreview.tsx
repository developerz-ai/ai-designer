import { createMemo, For, onMount, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { Edit } from '@/shared/changeset';
import {
  canRedo,
  canUndo,
  changeset,
  clearChangeset,
  curating,
  diffError,
  initChangesetStore,
  redoEdit,
  refreshChangeset,
  removeEdit,
  undoEdit,
} from '../stores/changeset';
import { streaming } from '../stores/chat';
import './ChangesetPreview.scss';
import { describeSelector } from './chat/ContextChip';
import { Icon } from './Icon';

// Render + dispatch only (CLAUDE.md "SolidJS + SRP"): the edit list, per-edit formatting, and the
// undo/redo/clear/remove click handlers live here; every read + mutation is an RPC through
// ../stores/changeset, the thin reflection of the SW's durable ChangesetStore. This curates the
// SHIPPABLE record — it never reverts the live page (edits are ephemeral; #10). The mutating
// controls are disabled while a turn is streaming (the SW rejects a mid-turn op anyway — the turn
// owns the live store) or a curation RPC is already in flight.
export function ChangesetPreview() {
  onMount(() => {
    initChangesetStore();
    void refreshChangeset();
  });

  const edits = createMemo<Edit[]>(() => changeset()?.edits ?? []);
  const busy = createMemo(() => streaming() || curating());

  return (
    <div class="dz-diff">
      <header class="dz-diff__bar">
        <span class="dz-diff__count">{i18n.t('diff.count', edits().length)}</span>
        <div class="dz-diff__actions">
          <button
            type="button"
            class="dz-diff__action"
            aria-label={i18n.t('diff.undo.ariaLabel')}
            disabled={busy() || !canUndo()}
            onClick={() => void undoEdit()}
          >
            <Icon name="undo" size="sm" />
          </button>
          <button
            type="button"
            class="dz-diff__action"
            aria-label={i18n.t('diff.redo.ariaLabel')}
            disabled={busy() || !canRedo()}
            onClick={() => void redoEdit()}
          >
            <Icon name="redo" size="sm" />
          </button>
          <button
            type="button"
            class="dz-diff__action dz-diff__action--danger"
            disabled={busy() || edits().length === 0}
            onClick={() => void clearChangeset()}
          >
            <Icon name="trash" size="sm" /> {i18n.t('diff.clear')}
          </button>
        </div>
      </header>

      <Show when={diffError()}>
        <p class="dz-diff__error">
          <Icon name="warning" size="sm" /> {diffError()}
        </p>
      </Show>

      <Show
        when={edits().length > 0}
        fallback={<p class="dz-diff__empty">{i18n.t('diff.empty')}</p>}
      >
        <ol class="dz-diff__list">
          <For each={edits()}>
            {(edit, i) => <EditCard edit={edit} index={i()} disabled={busy()} />}
          </For>
        </ol>
      </Show>
    </div>
  );
}

// Screenshot srcs come from the model's recordEdit args, i.e. from a promptable page — render only
// inline `data:image/` sources. A remote URL would make opening this tab issue an unsolicited
// cross-origin fetch from the panel's origin (mirrors the `visionImages` guard in src/agent/report.ts).
const dataImage = (src: string | undefined): string | undefined =>
  src?.startsWith('data:image/') ? src : undefined;

function EditCard(props: { edit: Edit; index: number; disabled: boolean }) {
  return (
    <li class="dz-diff__item">
      <div class="dz-diff__head">
        <code class="dz-diff__selector" title={props.edit.selector.value}>
          {describeSelector(props.edit.selector, 60)}
        </code>
        <Show when={props.edit.selector.fragile}>
          <span class="dz-diff__fragile">
            <Icon name="warning" size="sm" /> {i18n.t('diff.fragile')}
          </span>
        </Show>
        <button
          type="button"
          class="dz-diff__remove"
          aria-label={i18n.t('diff.remove.ariaLabel')}
          disabled={props.disabled}
          onClick={() => void removeEdit(props.index)}
        >
          <Icon name="close" size="sm" />
        </button>
      </div>

      <p class="dz-diff__intent">{props.edit.intent}</p>

      <Show when={props.edit.changes.length > 0}>
        <div class="dz-diff__changes-wrap">
          <table class="dz-diff__changes">
            <thead>
              <tr>
                <th>{i18n.t('diff.changes.property')}</th>
                <th>{i18n.t('diff.changes.before')}</th>
                <th>{i18n.t('diff.changes.after')}</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.edit.changes}>
                {(c) => (
                  <tr>
                    <td class="dz-diff__prop">{c.prop}</td>
                    <td class="dz-diff__before">{c.before ?? '—'}</td>
                    <td class="dz-diff__after">{c.after}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <Show when={props.edit.text}>
        {(text) => (
          <div class="dz-diff__text">
            <span class="dz-diff__text-label">{i18n.t('diff.text.label')}</span>
            <del class="dz-diff__text-before">{text().before}</del>
            <ins class="dz-diff__text-after">{text().after}</ins>
          </div>
        )}
      </Show>

      <Show
        when={dataImage(props.edit.screenshots?.before) || dataImage(props.edit.screenshots?.after)}
      >
        <div class="dz-diff__shots">
          <Show when={dataImage(props.edit.screenshots?.before)}>
            {(src) => <img class="dz-diff__shot" src={src()} alt={i18n.t('diff.shot.before')} />}
          </Show>
          <Show when={dataImage(props.edit.screenshots?.after)}>
            {(src) => <img class="dz-diff__shot" src={src()} alt={i18n.t('diff.shot.after')} />}
          </Show>
        </div>
      </Show>

      <Show when={props.edit.frameworkHints.length > 0}>
        <div class="dz-diff__hints">
          <span class="dz-diff__hints-label">{i18n.t('diff.hints.label')}</span>
          <For each={props.edit.frameworkHints}>
            {(hint) => <span class="dz-diff__hint">{hint}</span>}
          </For>
        </div>
      </Show>

      <Show when={props.edit.breakpoint}>
        {(bp) => (
          <span class="dz-diff__breakpoint">
            {i18n.t('diff.breakpoint.label')}: {bp()}
          </span>
        )}
      </Show>
    </li>
  );
}
