import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { i18n } from '#i18n';
import { settings, switchModel } from '../../stores/settings';
import { dismissOnOutsidePress } from '../dismiss';
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

/** Case-insensitive substring match over id and display name. A gateway catalogue runs to ~300
 *  entries, which is not a list anyone scrolls — exported so the match rule is unit-testable
 *  without mounting the menu. */
export function filterModels<T extends { id: string; name: string }>(
  models: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...models];
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
}

export function ModelPicker() {
  const [open, setOpen] = createSignal(false);
  let rootEl: HTMLDivElement | undefined;
  // Roving focus: only the active item is tabbable (`tabindex="-1"` on the rest), which is what
  // `role="menu"` requires — Tab leaves the menu, arrows move within it.
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [query, setQuery] = createSignal('');

  let triggerEl: HTMLButtonElement | undefined;
  let searchEl: HTMLInputElement | undefined;
  // The MENU element, not a per-row ref array. A `ref` callback fires once, at row creation, so
  // an `itemEls[i()] = el` cache captures the index the row had THEN — and `<For>` moves surviving
  // rows on a filter instead of recreating them, so the callback never re-fires. Narrowing the
  // list left the cache pointing at detached nodes: ArrowDown focused nothing, Enter did nothing,
  // and the model could not be picked by keyboard at all. Querying the live DOM cannot go stale.
  let menuEl: HTMLDivElement | undefined;
  // True only while the user is arrowing. Without it the focus effect below would yank focus
  // out of the search field the instant the menu opened, and typing would go nowhere.
  const [navigating, setNavigating] = createSignal(false);

  const allModels = createMemo(() => settings.models);
  const models = createMemo(() => filterModels(allModels(), query()));
  const label = createMemo(() => settings.model ?? i18n.t('composer.modelFallback'));
  const noModels = createMemo(() => allModels().length === 0);

  // Moving DOM focus onto the active item is the one thing a menu cannot express declaratively;
  // it runs off the two signals that define "where focus belongs" rather than from an event
  // handler, so open-at-index and arrow-move share a single path.
  createEffect(() => {
    if (!open()) return;
    // The menu opens onto the SEARCH field — that is where a keystroke should land when the
    // catalogue is 300 entries long. Focus only moves onto a row once the user arrows.
    if (!navigating()) {
      searchEl?.focus();
      return;
    }
    // Read the index inside the effect so it stays a tracked dependency of this computation.
    const index = activeIndex();
    menuEl?.querySelectorAll<HTMLButtonElement>('.dz-modelpicker__item')[index]?.focus();
  });

  function openMenu(index: number): void {
    if (noModels()) return;
    setQuery(''); // a stale filter from last time would open onto "no matches"
    setNavigating(false);
    setActiveIndex(index);
    setOpen(true);
  }

  /** Close and hand focus back to the trigger — without this, dismissing the menu drops focus on
   *  `<body>` and a keyboard user restarts from the top of the panel. */
  function closeMenu(): void {
    setOpen(false);
    triggerEl?.focus();
  }

  // Pressing anywhere outside the picker closes it. `setOpen(false)` rather than `closeMenu()`:
  // closing pulls focus back to the trigger, which is right for Escape and wrong for a press —
  // it would yank focus away from whatever the user just clicked.
  dismissOnOutsidePress(
    () => rootEl,
    open,
    () => setOpen(false),
  );

  /** Typing narrows the list under the cursor, so the roving index has to come back to the top —
   *  otherwise index 4 of the old list points at nothing, or at the wrong model. */
  function onSearch(value: string): void {
    setQuery(value);
    setNavigating(false); // keep the cursor in the field; the list re-ranks under it
    setActiveIndex(0);
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
      setNavigating(true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(models().length - 1);
      setNavigating(true);
    }
  }

  function onMenuKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' || e.key === 'Tab') {
      // Tab closes too: a menu left open behind the focus ring is a stale popover.
      if (e.key === 'Escape') e.preventDefault();
      closeMenu();
      return;
    }
    // Enter from the search field takes the highlighted row — the whole point of typing three
    // characters is not having to reach for the mouse afterwards.
    if (e.key === 'Enter' && !navigating()) {
      const model = models()[activeIndex()];
      if (!model) return;
      e.preventDefault();
      pick(model.id);
      return;
    }
    const next = nextMenuIndex(e.key, activeIndex(), models().length);
    if (next === null) return;
    e.preventDefault();
    setNavigating(true);
    setActiveIndex(next);
  }

  return (
    <div class="dz-modelpicker" ref={rootEl}>
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
        {/* The popover wraps the search field AND the menu. The field is deliberately a SIBLING
            of `role="menu"`, not a child: a menu may only own `menuitem*` nodes, so a textbox
            inside one is invalid ARIA. The keydown handler is attached to BOTH interactive
            children rather than to this wrapper: arrows must drive the list whether the cursor
            is in the field or focus has moved onto a row, and a handler on a plain div is a
            static-element interaction. */}
        <div class="dz-modelpicker__popover">
          {/* A gateway catalogue runs to ~300 entries. Scrolling that is not a way to pick a
              model; typing three characters is. */}
          <div class="dz-modelpicker__search">
            <Icon name="search" size="sm" class="dz-icon--fixed" />
            <input
              ref={searchEl}
              type="text"
              value={query()}
              placeholder={i18n.t('composer.model.search', [String(allModels().length)])}
              aria-label={i18n.t('composer.model.search', [String(allModels().length)])}
              aria-controls={MENU_ID}
              onInput={(e) => onSearch(e.currentTarget.value)}
              onKeyDown={onMenuKeyDown}
            />
          </div>

          {/* A `div`, not a `ul`: a `menu` may only own `menuitem*` children, so a list would
              need every `li` neutralised with `role="none"` to be legal anyway — and this is
              the shape the linter accepts for an interactive role. */}
          <div
            id={MENU_ID}
            class="dz-modelpicker__menu"
            role="menu"
            ref={menuEl}
            aria-labelledby={TRIGGER_ID}
            onKeyDown={onMenuKeyDown}
          >
            <For each={models()}>
              {(m, i) => (
                <button
                  type="button"
                  role="menuitemradio"
                  class="dz-modelpicker__item"
                  aria-checked={m.id === settings.model}
                  tabindex={i() === activeIndex() ? 0 : -1}
                  onClick={() => pick(m.id)}
                >
                  {/* A check column, always present and transparent when unselected: tone alone
                      moved the row's text when selection changed, and a list that reflows as you
                      arrow through it is hard to track. */}
                  <Icon
                    name="check"
                    size="sm"
                    class={`dz-modelpicker__check${m.id === settings.model ? ' is-on' : ''}`}
                  />
                  <span class="dz-modelpicker__name">{m.name}</span>
                </button>
              )}
            </For>
            <Show when={models().length === 0}>
              <p class="dz-modelpicker__empty">{i18n.t('composer.model.noMatch')}</p>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
