import { createSignal, Match, Switch } from 'solid-js';
import { ChatPanel } from './components/ChatPanel';
import { McpPanel } from './components/McpPanel';
import './App.scss';

type Tab = 'chat' | 'mcp';

// Root side-panel shell: two surfaces — the design conversation (Chat) and the
// implement-backend management (MCP). See docs/idea/ui.md.
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
          <button
            type="button"
            classList={{ 'is-active': tab() === 'mcp' }}
            onClick={() => setTab('mcp')}
          >
            MCP
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
        </Switch>
      </main>
    </div>
  );
}
