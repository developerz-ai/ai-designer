import type { AuthKind } from '@/shared/messages';

export const DEVELOPERZ_MCP_ENDPOINT = 'https://mcp.developerz.ai/v1/mcp';

export interface McpBackendPreset {
  id: string;
  label: string;
  url: string;
  authKind: AuthKind;
}

/** Built-in backends offered by the side-panel quick-add controls. */
export const MCP_BACKEND_PRESETS: readonly McpBackendPreset[] = [
  {
    id: 'developerz',
    label: 'developerz.ai',
    url: DEVELOPERZ_MCP_ENDPOINT,
    authKind: 'oauth',
  },
];
