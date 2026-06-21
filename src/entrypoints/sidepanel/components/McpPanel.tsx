import { For } from 'solid-js';
import './McpPanel.scss';

interface McpBackend {
  id: string;
  label: string;
  url: string;
  connected: boolean;
}

// MCP management — where the work lands. Connect implement backends (ai-dev,
// developerz.ai, GitHub MCP) the agent dispatches tasks to. See docs/idea/mcp.md.
// Connections + auth (OAuth/PKCE, API keys) are TODO; this is the shell.
const DEFAULT_BACKENDS: McpBackend[] = [
  {
    id: 'ai-dev',
    label: 'Tesote AI Dev',
    url: 'https://ai-dev.miamibeachstart.com/mcp',
    connected: false,
  },
  { id: 'developerz', label: 'developerz.ai', url: 'https://developerz.ai/mcp', connected: false },
];

export function McpPanel() {
  return (
    <div class="dz-mcp">
      <p class="dz-mcp__hint">Connect an implement backend. The agent ships changesets here.</p>
      <ul class="dz-mcp__list">
        <For each={DEFAULT_BACKENDS}>
          {(b) => (
            <li class="dz-mcp__item">
              <div>
                <strong>{b.label}</strong>
                <small>{b.url}</small>
              </div>
              <button type="button" classList={{ 'is-connected': b.connected }}>
                {b.connected ? 'Connected' : 'Connect'}
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
