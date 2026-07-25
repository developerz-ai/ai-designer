import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { Edit, StableSelector, StructuralChange } from '@/shared/changeset';
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

// How long an armed "Clear session" stays armed before it disarms itself — long enough to read
// the armed label, short enough that a stray first click can't fire much later.
export const CLEAR_CONFIRM_MS = 4000;

/** The clear-session confirm step (#142): clear wipes the record AND the redo stack,
 *  irreversibly, so one click never fires it — the first click ARMS (the button re-labels and
 *  the auto-disarm timer starts), only a click while armed FIRES. The component disarms on
 *  timeout or pointer-leave. Exported for unit coverage (mirrors ReadinessDropdown's
 *  `sessionButton` seam). */
export function clearClick(armed: boolean): { fire: boolean; armed: boolean } {
  return armed ? { fire: true, armed: false } : { fire: false, armed: true };
}

// Render + dispatch only (CLAUDE.md "SolidJS + SRP"): the edit list, per-edit formatting, and the
// undo/redo/clear/remove click handlers live here; every read + mutation is an RPC through
// ../stores/changeset, the thin reflection of the SW's durable ChangesetStore. This curates the
// SHIPPABLE record — it never reverts the live page (edits are ephemeral; #10). The mutating
// controls are disabled while a turn is streaming (the SW rejects a mid-turn op anyway — the turn
// owns the live store) or a curation RPC is already in flight.
export function ChangesetPreview() {
  const [clearArmed, setClearArmed] = createSignal(false);
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  const disarmClear = () => {
    if (clearTimer !== undefined) {
      clearTimeout(clearTimer);
      clearTimer = undefined;
    }
    setClearArmed(false);
  };
  onCleanup(disarmClear);

  // Two-click inline confirm (no modal): arm on the first click, fire on the second; the timer
  // and the button's pointer-leave disarm (see `clearClick`).
  function handleClear(): void {
    if (!clearClick(clearArmed()).fire) {
      setClearArmed(true);
      clearTimer = setTimeout(disarmClear, CLEAR_CONFIRM_MS);
      return;
    }
    disarmClear();
    void clearChangeset();
  }

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
            class={`dz-diff__action dz-diff__action--danger${clearArmed() ? ' dz-diff__action--armed' : ''}`}
            disabled={busy() || edits().length === 0}
            onClick={handleClear}
            onPointerLeave={disarmClear}
          >
            <Icon name="trash" size="sm" />{' '}
            {clearArmed() ? i18n.t('diff.clearArmed') : i18n.t('diff.clear')}
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

// Per-variant accessors for the discriminated StructuralChange union (#142) — `insert` carries
// `html` (+ optional position/refSelector), `move` a required refSelector (+ optional position),
// `remove` neither. Keeps the JSX's `in`-narrowing out of the Show callbacks.
const structuralPosition = (s: StructuralChange): string | undefined =>
  'position' in s ? s.position : undefined;
const structuralRef = (s: StructuralChange): StableSelector | undefined =>
  'refSelector' in s ? s.refSelector : undefined;
const structuralHtml = (s: StructuralChange): string | undefined =>
  'html' in s ? s.html : undefined;

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
                    <td class="dz-diff__before">{c.before ?? '∅'}</td>
                    <td class="dz-diff__after">{c.after}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <Show when={props.edit.classes.length > 0}>
        <div class="dz-diff__classes">
          <span class="dz-diff__classes-label">{i18n.t('diff.classes.label')}</span>
          <For each={props.edit.classes}>
            {(c) => (
              <span class={`dz-diff__class dz-diff__class--${c.op}`}>
                {c.op === 'add' ? '+' : '−'}
                {c.name}
              </span>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.edit.attrs.length > 0}>
        <div class="dz-diff__changes-wrap">
          <table class="dz-diff__changes dz-diff__attrs">
            <thead>
              <tr>
                <th>{i18n.t('diff.attrs.attribute')}</th>
                <th>{i18n.t('diff.changes.before')}</th>
                <th>{i18n.t('diff.changes.after')}</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.edit.attrs}>
                {(a) => (
                  <tr>
                    <td class="dz-diff__prop">{a.name}</td>
                    <td class="dz-diff__before">{a.before ?? '∅'}</td>
                    <td class="dz-diff__after">{a.after ?? '∅'}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <Show when={props.edit.structural}>
        {(s) => (
          <div class="dz-diff__structural">
            <span class="dz-diff__structural-label">{i18n.t('diff.structural.label')}</span>
            <span class={`dz-diff__structural-op dz-diff__structural-op--${s().op}`}>{s().op}</span>
            <Show when={structuralPosition(s())}>
              {(pos) => <span class="dz-diff__structural-position">{pos()}</span>}
            </Show>
            <Show when={structuralRef(s())}>
              {(ref) => (
                <code class="dz-diff__structural-ref" title={ref().value}>
                  → {describeSelector(ref(), 60)}
                </code>
              )}
            </Show>
            <Show when={structuralHtml(s())}>
              {(html) => (
                <code class="dz-diff__structural-html" title={html()}>
                  {html()}
                </code>
              )}
            </Show>
          </div>
        )}
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
