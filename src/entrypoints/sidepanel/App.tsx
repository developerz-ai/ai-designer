import { createEffect, createMemo, Match, onMount, Show, Switch } from 'solid-js';
import { i18n } from '#i18n';
import { ChangesetPreview } from './components/ChangesetPreview';
import { ChatPanel } from './components/ChatPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { Icon } from './components/Icon';
import { McpPanel } from './components/McpPanel';
import { NavMenu, roomName } from './components/NavMenu';
import { Onboarding } from './components/Onboarding';
import { PreStart } from './components/PreStart';
import { createPresence } from './components/presence';
import type { DeepLinkTab } from './components/ReadinessDropdown';
import { ReadinessDropdown } from './components/ReadinessDropdown';
import { SettingsPanel } from './components/SettingsPanel';
import { initChatStore } from './stores/chat';
import { setTab, tab } from './stores/nav';
import { initOnboardingStore, visible as onboardingVisible } from './stores/onboarding';
import { initSessionStore, sessionState } from './stores/session';
import './App.scss';

// Root side-panel shell — composition only (CLAUDE.md "SolidJS + SRP"). Chrome is a quiet
// title row (brand + the readiness pill and its Start/Stop toggle, the single loud element
// in the panel) over the `TabBar`; the body hosts one surface at a time: the design
// conversation (Chat), the changeset (Diff), MCP backend management, History and Settings
// (BYOK provider key + model picker). See docs/idea/ui.md.
export function App() {
  // First-run guide: auto-shown on a fresh install and re-shown each open until skipped/finished
  // (see stores/onboarding.ts), plus re-openable from Settings. Rendered as an overlay below so it
  // sits above the tab shell.
  // Both idempotent (and re-called by ChatPanel/ReadinessDropdown on their own mounts). They belong
  // here because neither may wait on a TAB: the session store learns the SW's live lifecycle, and
  // ChatPanel — the only other caller of `initChatStore` — mounts only once that lifecycle is
  // non-idle. Reopening the panel mid-turn used to start at `idle`, render the pre-Start hint, and
  // drop every token/tool-call push of the still-running turn on the floor; the only button on
  // that screen was Start, which the SW treats as a new session and which aborted the live turn
  // (#165 S5).
  onMount(() => {
    initOnboardingStore();
    initSessionStore();
    initChatStore();
  });
  // Gates ChatPanel: false only in the pre-Start `idle` state — a `stopped` turn (Stop
  // clicked mid-run) keeps chat mounted, since the session itself is still open (see
  // stores/session.ts).
  const sessionStarted = createMemo(() => sessionState() !== 'idle');

  function handleNavigate(target: DeepLinkTab): void {
    setTab(target);
  }

  // A room change is a route change: without moving focus it is a silent swap for a screen
  // reader — the body is replaced and the user is still parked on whatever they clicked. The
  // `<Show>` keeps the same heading node across room-to-room moves, so this has to be an effect
  // on `tab`, not a `ref` callback (which fires once, on mount).
  const onboarding = createPresence(onboardingVisible, 200);

  let roomTitle: HTMLHeadingElement | undefined;
  createEffect(() => {
    if (tab() !== 'chat') roomTitle?.focus();
  });

  return (
    <div class="dz-app">
      <header class="dz-app__header">
        <img class="dz-app__logo" src="/logo.png" alt={i18n.t('app.logo.alt')} />
        <NavMenu />
        <ReadinessDropdown onNavigate={handleNavigate} />
      </header>

      {/* Only the four secondary surfaces get a bar. Chat is not a room you visit — it is the
          panel, and giving it a "back to itself" affordance would say otherwise. The bar is
          also the only heading MCP, History and Diff have ever had; the strip was their label. */}
      <Show when={tab() !== 'chat'}>
        <div class="dz-app__roombar">
          {/* Named "Chat", not "Back": it names the destination rather than a direction, and it
              keeps the accessible name every spec already looks for when returning. */}
          <button type="button" class="dz-app__back" onClick={() => setTab('chat')}>
            <Icon name="back" size="sm" class="dz-icon--fixed" />
            {i18n.t('app.tab.chat')}
          </button>
          <h2 ref={roomTitle} class="dz-app__roomtitle" tabindex="-1">
            {roomName(tab())}
          </h2>
        </div>
      </Show>

      <main class="dz-app__body">
        <Switch>
          <Match when={tab() === 'chat'}>
            <Show
              when={sessionStarted()}
              fallback={<PreStart onOpenSettings={() => setTab('settings')} />}
            >
              <ChatPanel />
            </Show>
          </Match>
          <Match when={tab() === 'diff'}>
            <ChangesetPreview />
          </Match>
          <Match when={tab() === 'mcp'}>
            <McpPanel />
          </Match>
          <Match when={tab() === 'history'}>
            <HistoryPanel />
          </Match>
          <Match when={tab() === 'settings'}>
            <SettingsPanel onStart={() => setTab('chat')} />
          </Match>
        </Switch>
      </main>

      {/* Held through its exit so the scrim and card fade out instead of blinking away — the
          first-run guide is dismissed by choice, and a hard cut on that click reads as a crash. */}
      <Show when={onboarding.mounted()}>
        <Onboarding onNavigate={handleNavigate} leaving={onboarding.leaving()} />
      </Show>
    </div>
  );
}
