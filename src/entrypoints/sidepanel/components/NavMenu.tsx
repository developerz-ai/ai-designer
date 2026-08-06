import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { i18n } from '#i18n';
import { changeset, initChangesetStore, refreshChangeset } from '../stores/changeset';
import { setTab, type Tab, tab } from '../stores/nav';
import { Icon } from './Icon';
import type { IconName } from './icon-registry';
import './NavMenu.scss';

// The panel's navigation, as a disclosure on the wordmark rather than a strip of five peers.
//
// Chat is not a destination — it is the app, and it now owns the whole panel. The other four
// surfaces are visited to configure or to review, so they live one click behind "Designer ⌄" and
// each gets a glyph AND a word, which the old strip could not afford (three labels and two
// unguessable squares at 360px).
//
// The interaction engine is the native `popover` attribute: top layer, Escape, light dismiss and
// focus-return-to-invoker, all from the UA, zero listeners. That is the point — this codebase has
// two hand-rolled disclosures (ReadinessDropdown, ShipBar's send menu) and NEITHER closes on
// Escape or on an outside click. Everything here is attribute-driven, never imperative, because
// jsdom (the unit-test environment) has no Popover API at all.
//
// Render + dispatch only (CLAUDE.md "SolidJS + SRP"): the current surface lives in `stores/nav`,
// the edit count in `stores/changeset`.

const MENU_ID = 'dz-nav-menu';

interface RoomSpec {
  id: Tab;
  /** Accessible name AND visible label — one string, so WCAG 2.5.3 cannot be violated. These
   *  five are matched by name across the e2e suite; they are byte-identical to the old strip's. */
  name: string;
  icon: IconName;
}

// Work first, then the archive, then the plumbing. Built per render so the localized names
// resolve through the same `i18n.t` path as the rest of the panel.
export function roomSpecs(): RoomSpec[] {
  return [
    // No `chat` glyph in the registry, and none needed: `agent` is the assistant's own mark, the
    // same one the empty state and PreStart use. The conversation and the thing you converse with
    // sharing a glyph is a statement, not a shortage.
    { id: 'chat', name: i18n.t('app.tab.chat'), icon: 'agent' },
    { id: 'diff', name: i18n.t('app.tab.diff.ariaLabel'), icon: 'diff' },
    { id: 'history', name: i18n.t('app.tab.history.ariaLabel'), icon: 'history' },
    { id: 'mcp', name: i18n.t('app.tab.mcp'), icon: 'mcp' },
    { id: 'settings', name: i18n.t('app.tab.settings'), icon: 'settings' },
  ];
}

/** The surface's own name, for the room bar's heading. Exported so App renders the same string
 *  the menu row does, by construction rather than by a second literal. */
export function roomName(id: Tab): string {
  return roomSpecs().find((spec) => spec.id === id)?.name ?? '';
}

export function NavMenu() {
  const [open, setOpen] = createSignal(false);
  let menu: HTMLElement | undefined;

  // Moved verbatim from TabBar: `initChangesetStore` only SUBSCRIBES, so without the refresh a
  // panel reopened on a session that already had edits showed no count until the agent happened
  // to record another one — the badge silently wrong in exactly the case it exists for.
  onMount(() => {
    initChangesetStore();
    void refreshChangeset();
  });

  const editCount = createMemo(() => changeset()?.edits.length ?? 0);

  // `popover=auto` light-dismisses on an outside POINTER press, but not on focus leaving it. Tab
  // past the last row and the menu stays open in the top layer over whatever you focus next —
  // WCAG 2.2 AA 2.4.11 Focus Not Obscured. Feature-guarded: jsdom has no `hidePopover`.
  function closeOnFocusLeave(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (!menu || (next instanceof Node && menu.contains(next))) return;
    if ('hidePopover' in menu) menu.hidePopover();
  }

  return (
    <div class="dz-nav">
      {/* The heading stays a real `h1` and wraps the button — the canonical ARIA disclosure
          shape, so the panel keeps its top-level heading (EmptyState's `h2` still nests under
          it) while the wordmark becomes interactive. */}
      <h1 class="dz-nav__heading">
        <button
          type="button"
          class="dz-nav__trigger"
          popovertarget={MENU_ID}
          aria-controls={MENU_ID}
          // Declared, not inferred. A `popovertarget` invoker gets an implicit expanded state in
          // Chrome, but this also builds for Firefox (`bun run dev:firefox`), where that mapping
          // is not something to bet an a11y attribute on.
          aria-expanded={open()}
        >
          <span class="dz-nav__wordmark">{i18n.t('app.panelTitle')}</span>
          <Icon name="chevronDown" size="sm" class="dz-nav__chevron dz-icon--fixed" />
        </button>
      </h1>

      <nav
        ref={menu}
        id={MENU_ID}
        popover
        class="dz-nav__menu"
        aria-label={i18n.t('app.nav.ariaLabel')}
        on:toggle={(event) => setOpen(event.newState === 'open')}
        on:focusout={closeOnFocusLeave}
      >
        <For each={roomSpecs()}>
          {(spec) => (
            <button
              type="button"
              class="dz-nav__row"
              // Closing via the ATTRIBUTE, not an imperative `hidePopover()` — the imperative
              // call throws in jsdom, where the attribute is simply ignored. Same reason the
              // trigger has no click handler of its own.
              popovertarget={MENU_ID}
              popovertargetaction="hide"
              // Deliberately NOT role="menuitem": these are route-like destinations, `role=menu`
              // would oblige roving tabindex + arrow keys + type-ahead, and the whole e2e suite
              // locates them as buttons. This is APG's Disclosure Navigation Menu, where Tab is
              // the required keyboard model.
              aria-current={tab() === spec.id ? 'page' : undefined}
              onClick={() => setTab(spec.id)}
            >
              <Icon name={spec.icon} size="sm" class="dz-icon--fixed" />
              <span class="dz-nav__label">{spec.name}</span>
              {/* Real text inside the row's accessible name, where the old strip had an
                  `aria-hidden` numeral on an unlabelled square — a count screen readers never
                  got at all. "Diff · 4 edits" still substring-matches `{ name: 'Diff' }`. */}
              <Show when={spec.id === 'diff' && editCount() > 0}>
                <span class="dz-nav__count">{i18n.t('diff.count', editCount())}</span>
              </Show>
            </button>
          )}
        </For>
      </nav>
    </div>
  );
}
