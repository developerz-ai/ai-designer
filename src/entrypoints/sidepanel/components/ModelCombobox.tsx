import { createMemo, createSignal, For, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { ModelOption } from '@/shared/messages';
import { Icon } from './Icon';
import './ModelCombobox.scss';

// Searchable, free-text model picker. A `<select>` cannot express either half of what this
// control needs: OpenRouter's catalogue is ~300 entries (unusable as a flat native dropdown, and
// it has no search), and a model the endpoint doesn't list — a brand-new id like
// `minimax/hailuo-3`, or anything behind a gateway whose `/models` is incomplete — was simply
// unreachable, because a `<select>` can only hold values it was given. So: the input's text IS
// the model id (type or paste anything), and the list below it is a filtered view of whatever
// `/models` returned, for the far more common case of picking one.
//
// Render + dispatch only (CLAUDE.md "SolidJS + SRP"): the options and the current value are
// props, every commit goes out through `onCommit`. No fetching, no store access.

export interface ModelComboboxProps {
  /** DOM id for the text input, so a `<label for>` outside this component still points at it. */
  id: string;
  /** The committed model id (`''` when none is chosen yet). */
  value: string;
  /** Everything `/models` returned for the current endpoint. May be empty (not yet loaded). */
  options: readonly ModelOption[];
  /** Disables the input while the list is being fetched. */
  loading?: boolean;
  /** The chosen id — a list pick, or whatever free text was typed/pasted. */
  onCommit: (model: string) => void;
}

/** Case-insensitive substring match over BOTH the id and the display name: users search by
 *  vendor prefix (`minimax/`) as often as by product name (`hailuo`). Pure + exported so the
 *  filter contract is unit-testable without mounting Solid. */
export function filterModels(
  options: readonly ModelOption[],
  query: string,
): readonly ModelOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
}

/** Next active-option index for an arrow/Home/End press, or `null` when the key isn't a move.
 *  Wraps at both ends; mirrors the chat ModelPicker's menu contract. Pure, unit-testable. */
export function nextOptionIndex(key: string, current: number, count: number): number | null {
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

export function ModelCombobox(props: ModelComboboxProps) {
  // The typed query is LOCAL and only exists while the list is open: closed, the input shows the
  // committed `props.value`, so the control always reads as "this is the model in use" rather
  // than stranding a half-typed filter that was never chosen.
  const [query, setQuery] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);

  const listId = `${props.id}-list`;
  const text = createMemo(() => query() ?? props.value);
  const matches = createMemo(() => filterModels(props.options, query() ?? ''));
  // The typed text is offered as its own row whenever it isn't already an exact id in the list —
  // the affordance that tells the user free text is accepted at all.
  const custom = createMemo(() => {
    const typed = (query() ?? '').trim();
    if (!typed || props.options.some((m) => m.id === typed)) return null;
    return typed;
  });
  // Row order in the popover: the custom row (when present) sits first, then the matches. One
  // flat list keeps the arrow-key index and the click targets in agreement.
  const rows = createMemo<string[]>(() => {
    const ids = matches().map((m) => m.id);
    const typed = custom();
    return typed ? [typed, ...ids] : ids;
  });

  function commit(model: string): void {
    setOpen(false);
    setQuery(null);
    if (model) props.onCommit(model);
  }

  function onInput(e: InputEvent & { currentTarget: HTMLInputElement }): void {
    setQuery(e.currentTarget.value);
    setActiveIndex(0);
    setOpen(true);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      // Abandon the filter, keep the committed value — Escape reverts, it doesn't clear.
      e.preventDefault();
      setOpen(false);
      setQuery(null);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter with the list up takes the highlighted row; with it closed it commits exactly what
      // is in the box, which is what makes paste-then-Enter work.
      const picked = open() ? rows()[activeIndex()] : undefined;
      commit(picked ?? text().trim());
      return;
    }
    if (!open() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setOpen(true);
      setActiveIndex(0);
      return;
    }
    const next = nextOptionIndex(e.key, activeIndex(), rows().length);
    if (next === null) return;
    e.preventDefault();
    setActiveIndex(next);
  }

  // Blur commits whatever is typed: a pasted id followed by a click on Save must not be thrown
  // away just because the field lost focus without an Enter. `relatedTarget` inside this control
  // (an option `mousedown`) is not a real exit — the click handler commits instead.
  function onBlur(e: FocusEvent & { currentTarget: HTMLInputElement }): void {
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.parentElement?.contains(next)) return;
    const typed = query();
    setOpen(false);
    setQuery(null);
    if (typed?.trim() && typed.trim() !== props.value) commit(typed.trim());
  }

  return (
    <div class="dz-modelcombo">
      <input
        id={props.id}
        class="dz-modelcombo__input"
        type="text"
        role="combobox"
        autocomplete="off"
        spellcheck={false}
        aria-autocomplete="list"
        aria-expanded={open()}
        aria-controls={open() ? listId : undefined}
        disabled={props.loading}
        placeholder={i18n.t('settings.model.placeholder')}
        value={text()}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onFocus={() => setOpen(true)}
      />
      <button
        type="button"
        class="dz-modelcombo__caret"
        // Out of the tab order (the input is the control and it opens the list on focus), but
        // still labelled — a mouse/AT user who lands on it should know what it does.
        tabindex={-1}
        aria-label={i18n.t('settings.model.toggleList')}
        disabled={props.loading}
        onMouseDown={(e) => {
          e.preventDefault(); // keep focus in the input so the list has something to filter
          setOpen((v) => !v);
        }}
      >
        <Icon name="chevronDown" size="sm" />
      </button>

      <Show when={open() && rows().length > 0}>
        <div id={listId} class="dz-modelcombo__list" role="listbox">
          <For each={rows()}>
            {(id, i) => (
              <button
                type="button"
                role="option"
                class="dz-modelcombo__option"
                classList={{
                  'is-active': i() === activeIndex(),
                  'is-custom': id === custom(),
                }}
                aria-selected={id === props.value}
                tabindex={-1}
                onMouseDown={(e) => e.preventDefault()} // commit on click, not on the blur it causes
                onClick={() => commit(id)}
              >
                <Show
                  when={id !== custom()}
                  fallback={
                    <span class="dz-modelcombo__name">
                      {i18n.t('settings.model.useCustom', { id })}
                    </span>
                  }
                >
                  <span class="dz-modelcombo__name">
                    {props.options.find((m) => m.id === id)?.name ?? id}
                  </span>
                  <span class="dz-modelcombo__id">{id}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
