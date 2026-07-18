import { createMemo, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { StableSelector } from '@/shared/messages';
import { clearFocus, pickerActive, selector, stopPicker } from '../../stores/focus';
import { Icon } from '../Icon';
import './ContextChip.scss';

// Cursor-style context pin: shows what the picker attached to the conversation (`stores/focus.ts`
// — the SW/content-script picker stream, not local state) as a dismissable chip above the
// Composer. Two states share one chip so the row doesn't jump: "Picking…" while the user is
// still clicking a target on the page, then the resolved element once one lands. Dispatch-only —
// dismiss routes back through the focus store (CLAUDE.md "SolidJS + SRP").
const STRATEGY_LABEL: Record<StableSelector['strategy'], string> = {
  'data-attr': i18n.t('contextChip.strategy.dataAttr'),
  id: i18n.t('contextChip.strategy.id'),
  aria: i18n.t('contextChip.strategy.aria'),
  text: i18n.t('contextChip.strategy.text'),
  'css-path': i18n.t('contextChip.strategy.cssPath'),
  shadow: i18n.t('contextChip.strategy.shadow'),
};

/** Formats a pinned selector for the chip's single-line label: value first (truncated so a
 *  long CSS path or text match doesn't blow out the composer's width), strategy as context.
 *  Pure so it's unit-testable without mounting Solid. */
export function describeSelector(sel: StableSelector, maxLength = 40): string {
  const value = sel.value.length > maxLength ? `${sel.value.slice(0, maxLength - 1)}…` : sel.value;
  return `${value} · ${STRATEGY_LABEL[sel.strategy]}`;
}

export function ContextChip() {
  const active = createMemo(() => pickerActive());
  const picked = createMemo(() => selector());
  const visible = createMemo(() => active() || picked() !== null);

  function dismiss(): void {
    if (active()) {
      void stopPicker();
    } else {
      clearFocus();
    }
  }

  return (
    <Show when={visible()}>
      <div
        class="dz-context-chip"
        classList={{ 'dz-context-chip--picking': active() && !picked() }}
      >
        <Icon name="picker" size="sm" spin={active() && !picked()} />
        <Show
          when={picked()}
          fallback={<span class="dz-context-chip__label">{i18n.t('contextChip.picking')}</span>}
        >
          {(sel) => (
            <span
              class="dz-context-chip__label"
              classList={{ 'dz-context-chip__label--fragile': sel().fragile }}
            >
              {describeSelector(sel())}
            </span>
          )}
        </Show>
        <button
          type="button"
          class="dz-context-chip__dismiss"
          aria-label={i18n.t('contextChip.remove.ariaLabel')}
          onClick={dismiss}
        >
          <Icon name="close" size="sm" />
        </button>
      </div>
    </Show>
  );
}
