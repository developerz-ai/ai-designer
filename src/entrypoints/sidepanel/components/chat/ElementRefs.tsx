import { createMemo, createSignal, For, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { StableSelector } from '@/shared/messages';
import {
  multiSelectors,
  orderedReferences,
  pickerActive,
  removeReference,
  selector,
  stopPicker,
} from '../../stores/focus';
import { Icon } from '../Icon';
import { ContextChip } from './ContextChip';
import './ElementRefs.scss';

// The conversation's attached elements, as a row above the composer. Every reference the agent
// will be grounded on is visible here, numbered to match its rectangle on the page.
//
// Render + dispatch only (CLAUDE.md "SolidJS + SRP"): the set itself lives in `stores/focus.ts`,
// fed by the content script's picker relay, and every mutation goes back through that store.

/** How many chips render inline before the row folds into a single stack chip. Three is what
 *  fits one line at the 360px panel floor without the composer moving — a fourth chip wrapped
 *  the row onto a second line and pushed the input down mid-conversation. Exported so the
 *  threshold is asserted rather than rediscovered. */
export const INLINE_LIMIT = 3;

/** Whether a reference set renders inline or collapsed. Pure — unit-testable without Solid. */
export function shouldCollapse(count: number): boolean {
  return count > INLINE_LIMIT;
}

export function ElementRefs() {
  // Local: whether the collapsed stack is currently unfolded. Deliberately NOT in the store —
  // it is a view state of this row, and a new pick should not silently re-fold what the user
  // just opened.
  const [open, setOpen] = createSignal(false);

  const picking = createMemo(() => pickerActive());
  const refs = createMemo<StableSelector[]>(() => orderedReferences(selector(), multiSelectors()));
  const collapsed = createMemo(() => shouldCollapse(refs().length) && !open());

  return (
    <Show when={picking() || refs().length > 0}>
      <div class="dz-element-refs">
        {/* Only while the picker is armed AND nothing is attached yet. `src/dom/picker.ts`
            deliberately stays armed after a pick (shift-click adds a second element), so a row
            that showed "Picking…" whenever `pickerActive` was true hid every reference the user
            had just made until they pressed Escape. Once a chip exists, the chips ARE the
            feedback and the still-armed picker is carried by the lit attach button instead. */}
        <Show when={picking() && refs().length === 0}>
          <span class="dz-context-chip dz-context-chip--picking">
            <Icon name="target" size="sm" class="dz-icon--fixed" spin />
            <span class="dz-context-chip__label">{i18n.t('contextChip.picking')}</span>
            <button
              type="button"
              class="dz-context-chip__dismiss"
              aria-label={i18n.t('contextChip.stopPicking.ariaLabel')}
              onClick={() => void stopPicker()}
            >
              <Icon name="close" size="sm" class="dz-icon--fixed" />
            </button>
          </span>
          <span class="dz-element-refs__hint">{i18n.t('contextChip.pickingHint')}</span>
        </Show>

        <Show when={collapsed()}>
          {/* Collapsed: the index squares are a preview of what is attached, so the row still
              says "three-plus specific elements" rather than only a number. */}
          <button
            type="button"
            class="dz-element-refs__stack"
            aria-expanded={false}
            onClick={() => setOpen(true)}
          >
            <span class="dz-element-refs__indices" aria-hidden="true">
              <For each={refs().slice(0, INLINE_LIMIT)}>
                {(_, i) => <span class="dz-element-refs__index">{i() + 1}</span>}
              </For>
            </span>
            <span class="dz-element-refs__count">{i18n.t('contextChip.count', refs().length)}</span>
            <Icon name="chevronDown" size="sm" class="dz-element-refs__chevron" />
          </button>
          {/* `stopPicker`, not `clearFocus`. Clear has the same trap the per-chip dismiss had:
              the picker owns the committed selection in the content world, so a panel-local
              reset left every element still selected on the page and the next shift-click
              echoed all of them back. `stopPicker` clears locally AND sends `stop-picker`,
              whose `picker.stop()` calls `clearSelected()` — authoritative on both sides. */}
          <button type="button" class="dz-element-refs__clear" onClick={() => void stopPicker()}>
            {i18n.t('contextChip.clear')}
          </button>
        </Show>

        <Show when={!collapsed()}>
          <For each={refs()}>
            {(ref, i) => (
              <ContextChip index={i() + 1} selector={ref} onRemove={() => removeReference(i())} />
            )}
          </For>
          {/* Only offered once the row was expanded from a stack — with three or fewer chips
              each one already carries its own dismiss and a second control is clutter. */}
          <Show when={open() && shouldCollapse(refs().length)}>
            <button
              type="button"
              class="dz-element-refs__collapse"
              aria-expanded
              onClick={() => setOpen(false)}
            >
              {i18n.t('contextChip.collapse')}
              <Icon name="chevronDown" size="sm" class="dz-element-refs__chevron is-open" />
            </button>
          </Show>
        </Show>
      </div>
    </Show>
  );
}
