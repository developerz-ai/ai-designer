import { createMemo, createSignal, Match, Show, Switch } from 'solid-js';
import { ChatPanel } from './components/ChatPanel';
import { McpPanel } from './components/McpPanel';
import type { DeepLinkTab } from './components/ReadinessDropdown';
import { ReadinessDropdown } from './components/ReadinessDropdown';
import { SettingsPanel } from './components/SettingsPanel';
import { sessionState } from './stores/session';
import './App.scss';

type Tab = 'chat' | 'mcp' | 'settings';

// MCP server management is live (slice 02) — connect implement backends the agent
// ships changesets to. See docs/idea/mcp.md.
const SHOW_MCP = true;

// Root side-panel shell. Surfaces: the header readiness pill (Start/Stop gate), the
// design conversation (Chat), MCP backend management, and Settings (BYOK provider key +
// model picker). See docs/idea/ui.md.
export function App() {
  const [tab, setTab] = createSignal<Tab>('chat');
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
        <img class="dz-app__logo" src="/logo.png" alt="developerz.ai" />
        <ReadinessDropdown onNavigate={handleNavigate} />
        <nav class="dz-app__tabs">
          <button
            type="button"
            classList={{ 'is-active': tab() === 'chat' }}
            onClick={() => setTab('chat')}
          >
            Chat
          </button>
          <Show when={SHOW_MCP}>
            <button
              type="button"
              classList={{ 'is-active': tab() === 'mcp' }}
              onClick={() => setTab('mcp')}
            >
              MCP
            </button>
          </Show>
          <button
            type="button"
            classList={{ 'is-active': tab() === 'settings' }}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </nav>
      </header>

      <main class="dz-app__body">
        <Switch>
          <Match when={tab() === 'chat'}>
            <Show
              when={sessionStarted()}
              fallback={
                <p class="dz-app__empty">
                  Configure a provider above, then hit Start to begin chatting.
                </p>
              }
            >
              <ChatPanel />
            </Show>
          </Match>
          <Match when={tab() === 'mcp'}>
            <McpPanel />
          </Match>
          <Match when={tab() === 'settings'}>
            <SettingsPanel />
          </Match>
        </Switch>
      </main>
    </div>
  );
}
