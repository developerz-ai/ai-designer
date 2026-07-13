import { createSignal, Match, Show, Switch } from 'solid-js';
import { ChatPanel } from './components/ChatPanel';
import { McpPanel } from './components/McpPanel';
import { SettingsPanel } from './components/SettingsPanel';
import './App.scss';

type Tab = 'chat' | 'mcp' | 'settings';

// MCP server management is live (slice 02) — connect implement backends the agent
// ships changesets to. See docs/idea/mcp.md.
const SHOW_MCP = true;

// Root side-panel shell. Surfaces: the design conversation (Chat), MCP backend
// management, and Settings (BYOK provider key + model picker). See docs/idea/ui.md.
export function App() {
  const [tab, setTab] = createSignal<Tab>('chat');

  return (
    <div class="dz-app">
      <header class="dz-app__header">
        <img class="dz-app__logo" src="/logo.png" alt="developerz.ai" />
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
            <ChatPanel />
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
