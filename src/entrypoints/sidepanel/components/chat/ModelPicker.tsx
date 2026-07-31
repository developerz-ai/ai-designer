import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { i18n } from '#i18n';
import { settings, switchModel } from '../../stores/settings';
import { Icon } from '../Icon';
import './ModelPicker.scss';

// Inline model quick-switch, split out of Composer (which owned two unrelated concerns: the
// draft/send contract and this menu). Reads `stores/settings` and dispatches `switchModel`
// itself — zero props, so nothing is drilled through Composer and the settings store stays out
// of Composer's imports entirely (CLAUDE.md "SolidJS + SRP", "never prop-drill").
//
// Rendered as Leo does it: a quiet *text* control ("Automatic ⌄"), not a bordered box — inside
// the composer shell a second border would read as a nested field.

const TRIGGER_ID = 'dz-modelpicker-trigger';
const MENU_ID = 'dz-modelpicker-menu';

/** Next roving-focus index for an arrow/Home/End press, or `null` if the key isn't a move.
 *  Wraps at both ends. Pure so the navigation contract is unit-testable without a real menu. */
export function nextMenuIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function ModelPicker() {
  const [open, setOpen] = createSignal(false);
  // Roving focus: only the active item is tabbable (`tabindex="-1"` on the rest), which is what
  // `role="menu"` requires — Tab leaves the menu, arrows move within it.
  const [activeIndex, setActiveIndex] = createSignal(0);

  let triggerEl: HTMLButtonElement | undefined;
  const itemEls: (HTMLButtonElement | undefined)[] = [];

  const models = createMemo(() => settings.models);
  const label = createMemo(() => settings.model ?? i18n.t('composer.modelFallback'));
  const noModels = createMemo(() => models().length === 0);

  // Moving DOM focus onto the active item is the one thing a menu cannot express declaratively;
  // it runs off the two signals that define "where focus belongs" rather than from an event
  // handler, so open-at-index and arrow-move share a single path.
  createEffect(() => {
    if (!open()) return;
    itemEls[activeIndex()]?.focus();
  });

  function openMenu(index: number): void {
    if (noModels()) return;
    setActiveIndex(index);
    setOpen(true);
  }

  /** Close and hand focus back to the trigger — without this, dismissing the menu drops focus on
   *  `<body>` and a keyboard user restarts from the top of the panel. */
  function closeMenu(): void {
    setOpen(false);
    triggerEl?.focus();
  }

  function pick(model: string): void {
    closeMenu();
    void switchModel(model);
  }

  function currentIndex(): number {
    const i = models().findIndex((m) => m.id === settings.model);
    return i >= 0 ? i : 0;
  }

  function onTriggerKeyDown(e: KeyboardEvent): void {
    if (open()) return; // the menu's own handler owns keys while it is up
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu(currentIndex());
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(models().length - 1);
    }
  }

  function onMenuKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' || e.key === 'Tab') {
      // Tab closes too: a menu left open behind the focus ring is a stale popover.
      if (e.key === 'Escape') e.preventDefault();
      closeMenu();
      return;
    }
    const next = nextMenuIndex(e.key, activeIndex(), models().length);
    if (next === null) return;
    e.preventDefault();
    setActiveIndex(next);
  }

  return (
    <div class="dz-modelpicker">
      <button
        type="button"
        id={TRIGGER_ID}
        class="dz-modelpicker__trigger"
        ref={triggerEl}
        disabled={noModels()}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={open() ? MENU_ID : undefined}
        onClick={() => (open() ? closeMenu() : openMenu(currentIndex()))}
        onKeyDown={onTriggerKeyDown}
      >
        <span class="dz-modelpicker__label">{label()}</span>
        {/* Inline with the label, so the `em` default is right here — the chevron should track
            the text it belongs to. */}
        <Icon name="chevronDown" size="sm" />
      </button>

      {/* Conditionally rendered, never `display: none` — a hidden-but-present menu keeps its
          items in the accessibility tree and in the tab order. */}
      <Show when={open()}>
        {/* A `div`, not a `ul`: a `menu` may only own `menuitem*` children, so a list would need
            every `li` neutralised with `role="none"` to be legal anyway — and this is the shape
            the linter accepts for an interactive role. */}
        <div
          id={MENU_ID}
          class="dz-modelpicker__menu"
          role="menu"
          aria-labelledby={TRIGGER_ID}
          onKeyDown={onMenuKeyDown}
        >
          <For each={models()}>
            {(m, i) => (
              <button
                type="button"
                role="menuitemradio"
                class="dz-modelpicker__item"
                ref={(el) => {
                  itemEls[i()] = el;
                }}
                aria-checked={m.id === settings.model}
                tabindex={i() === activeIndex() ? 0 : -1}
                onClick={() => pick(m.id)}
              >
                {m.name}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
