import { createMemo, createSignal, Match, onMount, Show, Switch } from 'solid-js';
import { i18n } from '#i18n';
import { ChangesetPreview } from './components/ChangesetPreview';
import { ChatPanel } from './components/ChatPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { Icon } from './components/Icon';
import { McpPanel } from './components/McpPanel';
import { Onboarding } from './components/Onboarding';
import type { DeepLinkTab } from './components/ReadinessDropdown';
import { ReadinessDropdown } from './components/ReadinessDropdown';
import { SettingsPanel } from './components/SettingsPanel';
import type { Tab } from './components/TabBar';
import { TabBar } from './components/TabBar';
import { initChatStore } from './stores/chat';
import { initOnboardingStore, visible as onboardingVisible } from './stores/onboarding';
import { initSessionStore, sessionState } from './stores/session';
import './App.scss';

// Root side-panel shell — composition only (CLAUDE.md "SolidJS + SRP"). Chrome is a quiet
// title row (brand + the readiness pill and its Start/Stop toggle, the single loud element
// in the panel) over the `TabBar`; the body hosts one surface at a time: the design
// conversation (Chat), the changeset (Diff), MCP backend management, History and Settings
// (BYOK provider key + model picker). See docs/idea/ui.md.
export function App() {
  const [tab, setTab] = createSignal<Tab>('chat');
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

  return (
    <div class="dz-app">
      <header class="dz-app__header">
        <img class="dz-app__logo" src="/logo.png" alt={i18n.t('app.logo.alt')} />
        <h1 class="dz-app__title">{i18n.t('app.panelTitle')}</h1>
        <ReadinessDropdown onNavigate={handleNavigate} />
      </header>

      <TabBar active={tab()} onSelect={setTab} />

      <main class="dz-app__body">
        <Switch>
          <Match when={tab() === 'chat'}>
            <Show
              when={sessionStarted()}
              fallback={
                <div class="dz-app__empty">
                  <Icon name="agent" size="lg" class="dz-icon--fixed dz-app__empty-icon" />
                  {/* The copy is one text node in one element on purpose:
                      test/e2e/readiness.spec.ts matches it verbatim with getByText. */}
                  <p class="dz-app__empty-text">{i18n.t('app.chat.empty')}</p>
                </div>
              }
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
            <SettingsPanel />
          </Match>
        </Switch>
      </main>

      <Show when={onboardingVisible()}>
        <Onboarding onNavigate={handleNavigate} />
      </Show>
    </div>
  );
}
